"""LLM-written section summaries (overview, specs, reviews) with a strict, JSON-only prompt.

The model sees only the part of ProductJSON the section needs and must return structured
output: a list of facts (claim + exact field_path), and sentences/items that reference those
facts by index. Before anything is used:
1. every fact is resolved against the real ProductJSON and must match its value;
2. every summary sentence and item must reference kept facts and agree with their values
   (numbers copied exactly, at least one shared word otherwise);
3. pros may not cite a negative review insight, cons may not cite a positive one;
4. the usual grounding check runs on the assembled AccessibleOutput.
If the call fails or too much had to be dropped, the caller uses the deterministic template.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

from app.brain import sections
from app.brain.format import short_title
from app.brain.grounding import CheckResult, Unresolved, claim_matches, numbers_in, resolve
from app.brain.llm import LLMError, LLMSettings, complete_json
from app.brain.output import OutputBuilder
from app.models import ProductJSON

log = logging.getLogger(__name__)

MAX_REVIEW_ITEMS = 20
MAX_REVIEW_CHARS = 600
MAX_DROPPED_SHARE = 0.3
MAX_ITEM_CHARS = 80
_MISSING = re.compile(r"\b(doesn't|does not|don't|do not|not) (list|show|say|mention|give)", re.I)
_SENTENCE_LIMIT = 2
_NUMBER = re.compile(r"\d+(?:,\d+)*(?:\.\d+)?")
_COUNT_NOUN_WRONG = {"rating.count": "review", "reviews.basis_count": "rating"}

KINDS = ["text", "pro", "con", "spec", "row", "warning"]

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["facts", "summary", "simpler", "sections"],
    "properties": {
        "facts": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["claim", "field_path"],
                "properties": {"claim": {"type": "string"}, "field_path": {"type": "string"}},
            },
        },
        "summary": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["text", "fact_refs"],
                "properties": {
                    "text": {"type": "string"},
                    "fact_refs": {"type": "array", "items": {"type": "integer"}},
                },
            },
        },
        "simpler": {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["text", "fact_refs"],
                    "properties": {
                        "text": {"type": "string"},
                        "fact_refs": {"type": "array", "items": {"type": "integer"}},
                    },
                },
                {"type": "null"},
            ]
        },
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["heading", "items"],
                "properties": {
                    "heading": {"type": "string"},
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["text", "kind", "fact_ref"],
                            "properties": {
                                "text": {"type": "string"},
                                "kind": {"type": "string", "enum": KINDS},
                                "fact_ref": {"type": ["integer", "null"]},
                            },
                        },
                    },
                },
            },
        },
    },
}

SYSTEM_PROMPT = """\
You write short shopping summaries for people who are blind, have low vision, have hand \
tremors or are elderly. They will hear your words read aloud.

You are given ONE product as JSON, taken from the shop's page. The JSON is your ONLY source.

ABSOLUTE RULES
1. Use ONLY facts that are present in the JSON. Do not use general knowledge about the \
brand, the product, the category or typical products. Do not guess, estimate, infer or \
recommend.
2. Copy every number exactly as it appears in the JSON. Never calculate anything: no \
discounts, percentages, differences, totals, averages or rounding. Prices may be written \
with the currency symbol and digit grouping (17999 INR -> ₹17,999).
3. Keep brand names, model names and units exactly as written.
4. If something this section would normally cover is null, empty or listed in "missing", \
say so plainly, for example "The page doesn't list the battery size." Never fill it in.
5. Review opinions: only say what the review fields say. Use mention counts when present. \
Never claim more reviews than reviews.basis_count. A pro must come from positive evidence, \
a con from negative or mixed evidence.
6. No marketing words (amazing, premium, best), no opinions of your own (such as what \
"matters" or is "good for"), no emoji, no markdown. Plain, natural English, short sentences, \
as a helpful shop assistant would say them aloud. Don't repeat field names ("Delivery is \
FREE delivery..."); say "Free delivery on Tuesday, 14 October".
7. rating.count is the number of star RATINGS; call it "ratings", never "reviews". \
reviews.basis_count is the number of REVIEWS. Never mix them up.
8. Always state values, not just names: say "a 5000 mAh battery", never only "battery \
capacity is a key spec".

OUTPUT (JSON matching the schema)
- facts: every fact you state. claim = the fact as you state it (e.g. "5000 mAh"). \
field_path = the exact path in the JSON where it is, using dots and [index], for example \
price.amount, specs.battery, reviews.insights[2], reviews.items[0].text. For a spec cite \
the whole spec (specs.<key>, which holds its label, value and unit) in ONE fact, e.g. \
{"claim": "5000 mAh", "field_path": "specs.battery"}. For a review topic cite the whole \
insight (reviews.insights[N]), which holds its topic and counts.
- summary: at most 2 short sentences (under 300 characters together), the most useful \
first. Each sentence lists the indexes of the facts it uses in fact_refs.
- simpler: one very plain sentence for someone who finds the summary hard, with its \
fact_refs, or null.
- sections: headed lists. Each item states at most one fact and gives its index in \
fact_ref; use null only for an item that says something is not listed.
"""

SECTION_TASKS = {
    "overview": (
        "Section: OVERVIEW. Summary sentence 1: the product's short name and its price (and "
        "the MRP if it is higher). Sentence 2: the rating out of 5 and the number of ratings. "
        "One section 'At a glance' with stock, delivery, seller and the variants (each as kind "
        "text), e.g. 'In stock', 'Free delivery on Tuesday, 14 October', 'Sold by X', "
        "'Colours: A (selected), B'. The variants item cites field_path 'variants'."
    ),
    "specs": (
        "Section: SPECS. Summary: 1 or 2 sentences that state the values of the 3 to 5 specs "
        "a buyer of this kind of product usually asks about first, chosen only from the specs "
        "given, e.g. 'It has a 5000 mAh battery, 8 GB RAM and 128 GB storage.' One section "
        "'Specs' with 8 to 12 specs when that many are given (kind spec), each short, "
        "written as 'Label: value unit'. When a spec's value is a long paragraph, state one "
        "short fact copied from it, e.g. 'Water resistance: IP68' or 'Video playback: up to "
        "22 hours', citing that spec."
    ),
    "reviews": (
        "Section: REVIEWS. Fact 0 must be {claim: 'N reviews', field_path: "
        "'reviews.basis_count'}. Summary: start with what it is based on ('Based on N "
        "reviews'), citing fact 0, then the main likes and the main complaint. Sections "
        "'Pros' (kind pro) for POSITIVE insights, 'Mixed opinions' (kind text) for MIXED "
        "insights and 'Cons' (kind con) for NEGATIVE insights; every insight goes in exactly "
        "one of them, with its mention counts, e.g. 'Battery life: 189 of 212 mentions are "
        "positive', 'Camera quality: 21 positive and 12 negative mentions', 'Heat: 11 of 12 "
        "mentions are negative'. Leave out a section that would be empty. If there are no "
        "insights, use the review texts. If there are no reviews, say so."
    ),
}

SECTION_FIELDS = {
    "overview": [
        "id", "title", "brand", "price", "rating", "availability", "category",
        "delivery", "seller", "sponsored", "variants", "missing",
    ],
    "specs": ["id", "title", "brand", "category", "specs", "missing"],
    "reviews": ["id", "title", "rating", "reviews", "missing"],
}  # fmt: skip

SECTION_MODEL = {"overview": "fast", "specs": "fast", "reviews": "main"}

# If the product has these fields, a usable answer must state them correctly.
REQUIRED_FACTS = {"overview": ["price.amount"], "specs": [], "reviews": ["reviews.basis_count"]}


def _plain_numbers(value: Any) -> Any:
    """5000.0 -> 5000, so the model copies numbers the way the page shows them."""
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, dict):
        return {k: _plain_numbers(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_plain_numbers(v) for v in value]
    return value


def section_input(name: str, product: dict[str, Any]) -> dict[str, Any]:
    """The part of ProductJSON this section may use; paths stay identical to the full JSON."""
    data = {k: _plain_numbers(product[k]) for k in SECTION_FIELDS[name]}
    reviews = data.get("reviews")
    if reviews:
        reviews = dict(reviews)
        reviews["items"] = [
            {**item, "text": item["text"][:MAX_REVIEW_CHARS]}
            for item in reviews["items"][:MAX_REVIEW_ITEMS]
        ]
        data["reviews"] = reviews
    return data


def recording_key(name: str, product_id: str) -> str:
    return f"summary/{name}.{re.sub(r'[^A-Za-z0-9.-]+', '_', product_id)}"


def models_for(name: str) -> list[str]:
    cfg = LLMSettings.load()
    main, fast = cfg.model, cfg.fast_model
    return [main, fast] if SECTION_MODEL[name] == "main" else [fast, main]


async def llm_section(name: str, p: ProductJSON, *, key: str | None = None) -> CheckResult:
    """Raise LLMError when the model's answer can't be used safely."""
    product = p.model_dump(mode="json", by_alias=True)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": SECTION_TASKS[name]
            + "\n\nPRODUCT JSON:\n"
            + json.dumps(section_input(name, product), ensure_ascii=False, separators=(",", ":")),
        },
    ]
    raw = await complete_json(
        key or recording_key(name, p.id),
        models_for(name),
        messages,
        OUTPUT_SCHEMA,
        name=f"{name}_summary",
    )
    return assemble(name, raw, p, product)


@dataclass
class _Fact:
    index: int  # into OutputBuilder.grounding
    value: Any
    path: str


def assemble(
    name: str, raw: dict[str, Any], p: ProductJSON, product: dict[str, Any]
) -> CheckResult:
    b = OutputBuilder(p.id)
    dropped: list[str] = []
    facts: dict[int, _Fact] = {}
    name_numbers: set[float] = set()
    if p.title:
        # The product's own name may be said anywhere; its digits ("5G") are not claims.
        product_name = short_title(p.title)
        b.ground(product_name, "title")
        name_numbers = numbers_in(product_name)
    for i, fact in enumerate(raw["facts"]):
        claim, path = fact["claim"], fact["field_path"]
        try:
            value = resolve(product, path)
        except Unresolved:
            dropped.append(f"fact has no field: {path} ({claim})")
            continue
        if not claim_matches(claim, value):
            dropped.append(f"fact does not match {path}: {claim}")
            continue
        facts[i] = _Fact(b.ground(claim, path), value, path)

    cited_specs: list[str] = []
    summary = []
    for sentence in raw["summary"][:_SENTENCE_LIMIT]:
        text, refs = _sentence(sentence["text"]), sentence["fact_refs"]
        if _supported(text, refs, facts, name_numbers):
            summary.append(text)
        else:
            dropped.append(f"summary sentence not supported: {text}")

    for section in raw["sections"]:
        items = []
        for item in section["items"]:
            text, kind, ref = item["text"].strip(), item["kind"], item["fact_ref"]
            if ref is None:
                if _MISSING.search(text):
                    items.append(b.item(text, kind))
                else:
                    dropped.append(f"item without a fact: {text}")
                continue
            fact = facts.get(ref)
            if (
                fact is None
                or not claim_matches(text, fact.value, name_numbers)
                or _mislabels_counts(text, [fact])
            ):
                dropped.append(f"item not supported: {text}")
                continue
            if not _sentiment_ok(kind, fact.path, product):
                dropped.append(f"{kind} cites the wrong sentiment: {text}")
                continue
            if fact.path.startswith("variants"):
                continue  # rebuilt by code below, so every option named is checked
            spec_key = _spec_key(fact.path)
            if name == "specs" and spec_key in p.specs:
                if spec_key in cited_specs or len(cited_specs) >= sections.MAX_SPEC_ITEMS:
                    continue
                cited_specs.append(spec_key)
                if len(text) > MAX_ITEM_CHARS:  # long page paragraph: first clause only
                    items.append(sections.spec_item(b, spec_key, p))
                    continue
            items.append({"text": text, "kind": kind, "grounding_index": fact.index})
        if items:
            b.section(section["heading"], items)

    warnings: list[str] = []
    if name == "overview" and p.variants:
        _section_named(b, "At a glance")["items"].extend(sections.variant_items(b, p))
    if name == "specs" and p.specs:
        # Same length and order whatever the model chose: fill up from the ranked specs.
        specs_items = _section_named(b, "Specs")["items"]
        for key in sections.ranked_spec_keys(p):
            if len(specs_items) >= sections.MAX_SPEC_ITEMS:
                break
            if key not in cited_specs:
                specs_items.append(sections.spec_item(b, key, p))
        warnings = sections.spec_warnings(b, p)

    simpler = raw["simpler"]
    if simpler is not None and not _supported(
        simpler["text"], simpler["fact_refs"], facts, name_numbers
    ):
        dropped.append(f"simpler not supported: {simpler['text']}")
        simpler = None
    result = b.checked(
        {p.id: p},
        " ".join(summary) if summary else "",
        simpler=simpler["text"].strip() if simpler else None,
        warnings=warnings,
    )
    result.dropped[:0] = dropped
    claims = len(raw["facts"]) + len(raw["summary"]) + sum(len(s["items"]) for s in raw["sections"])
    stated = {f.path for f in facts.values()}
    for path in REQUIRED_FACTS[name]:
        if _present(product, path) and path not in stated:
            raise LLMError(f"{name} answer does not state {path} correctly")
    if not summary:
        raise LLMError(f"no usable summary sentence ({len(result.dropped)} dropped)")
    if claims and len(result.dropped) / claims > MAX_DROPPED_SHARE:
        raise LLMError(
            f"too much dropped: {len(result.dropped)} of {claims}, e.g. {result.dropped[:3]}"
        )
    return result


def _spec_key(path: str) -> str | None:
    match = re.match(r"specs\.([a-z0-9_]+)", path)
    return match.group(1) if match else None


def _section_named(b: OutputBuilder, heading: str) -> dict[str, Any]:
    found = next((s for s in b.sections if s["heading"] == heading), None)
    if found is None:
        b.section(heading)
        found = b.sections[-1]
    return found


def _sentence(text: str) -> str:
    """Summary sentences are joined, so each must end with its own full stop."""
    text = text.strip()
    return text if text.endswith((".", "!", "?")) else f"{text}."


def _present(product: dict[str, Any], path: str) -> bool:
    try:
        resolve(product, path)
    except Unresolved:
        return False
    return True


def _supported(
    text: str, refs: list[int], facts: dict[int, _Fact], name_numbers: set[float]
) -> bool:
    if not refs:
        return bool(_MISSING.search(text))
    if any(r not in facts for r in refs):
        return False
    if _mislabels_counts(text, [facts[r] for r in refs]):
        return False
    return claim_matches(text, [facts[r].value for r in refs], name_numbers)


def _mislabels_counts(text: str, cited: list[_Fact]) -> bool:
    """Calling the ratings count "reviews" (or the reviews count "ratings") is wrong even
    though the number matches a field: "4.2 from 3,418 reviews"."""
    for fact in cited:
        wrong = _COUNT_NOUN_WRONG.get(fact.path)
        if wrong is None:
            continue
        for match in _NUMBER.finditer(text):
            if float(match.group().replace(",", "")) != float(fact.value):
                continue
            if re.match(rf"\s+(?:\w+\s+)?{wrong}s?\b", text[match.end() :], re.I):
                return True
    return False


def _sentiment_ok(kind: str, path: str, product: dict[str, Any]) -> bool:
    match = re.match(r"reviews\.insights\[(\d+)\]", path)
    if not match or kind not in ("pro", "con"):
        return True
    sentiment = product["reviews"]["insights"][int(match.group(1))]["sentiment"]
    return sentiment == "positive" if kind == "pro" else sentiment in ("negative", "mixed")
