"""POST /extract/fallback: tier-3 extraction from cleaned page text (Track B's request).

The LLM returns each field with the snippet it came from. A field is kept only if:
- its snippet is a verbatim part of the page text that was sent (whitespace/case aside);
- its value is in that snippet (every number in the value is a number in the snippet);
- it was asked for (a path in `missing`).
Nothing is guessed; what can't be backed this way stays null and listed in `missing`.

Price and MRP are never extracted here. They are payable information (docs/product.md), and
product pages are full of real-but-wrong prices: other variants, bank-offer and EMI prices,
"bought together" items. Tested live on a Flipkart page, the model returned the bank-offer
price (₹11,999) as the price (₹12,999) with every check passing. Price comes only from JSON-LD
and the site adapters; if they miss it, it stays missing.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import date
from typing import Any

from app.brain.grounding import numbers_in
from app.brain.llm import LLMSettings, complete_json
from app.brain.redact import redact
from app.models import SCHEMA_VERSION, ExtractFallbackRequest, ExtractFallbackResponse
from app.services.cache import TTLCache

log = logging.getLogger(__name__)

_cache = TTLCache(ttl_seconds=3600)

FIELDS = [
    "title", "brand", "rating", "rating_count", "availability",
    "category", "delivery", "delivery_cost", "seller", "spec",
]  # fmt: skip

# Which ProductJSON paths each extracted field fills (for matching `missing`).
FIELD_PATHS = {
    "title": "title",
    "brand": "brand",
    "rating": "rating.value",
    "rating_count": "rating.count",
    "availability": "availability.text",
    "category": "category",
    "delivery": "delivery.text",
    "delivery_cost": "delivery.cost",
    "seller": "seller",
    "spec": "specs",
}

OUTPUT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["items"],
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["field", "label", "value", "snippet"],
                "properties": {
                    "field": {"type": "string", "enum": FIELDS},
                    "label": {
                        "type": ["string", "null"],
                        "description": "For field 'spec': the spec name as on the page.",
                    },
                    "value": {"type": "string", "description": "Exactly as written on the page."},
                    "snippet": {
                        "type": "string",
                        "description": "The line of PAGE TEXT it came from, copied exactly.",
                    },
                },
            },
        }
    },
}

SYSTEM_PROMPT = """\
You extract product facts from the visible text of ONE product page. The text is your only \
source. Never guess, infer, convert or calculate; if a field is not clearly in the text, leave \
it out.

For each fact give: field, value exactly as written, and snippet = the line of PAGE TEXT it \
came from, copied character for character (lines are separated by newlines).
- rating: the star rating out of 5; rating_count: the number of ratings.
- delivery: the delivery promise line; delivery_cost: only if it says free or gives a cost.
- spec: one item per specification (label = its name, value = its value).
- Only extract the fields that are asked for.
"""


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _wanted(missing: list[str]) -> set[str]:
    """Extracted fields that fill any of the missing paths (all of them if none are given)."""
    if not missing:
        return set(FIELDS)
    out = set()
    for field, path in FIELD_PATHS.items():
        for m in missing:
            if (
                path == m
                or path.startswith(m + ".")
                or m.startswith(path + ".")
                or m == path.split(".")[0]
            ):
                out.add(field)
    return out


def _amount(value: str) -> float | None:
    nums = re.findall(r"\d+(?:,\d+)*(?:\.\d+)?", value)
    return float(nums[0].replace(",", "")) if nums else None


_MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1
)}  # fmt: skip


def _delivery_date(text: str, today: date) -> str | None:
    m = re.search(
        r"(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*", text, re.I
    )
    if not m:
        return None
    month = _MONTHS[m.group(2).lower()[:3]]
    year = today.year + (1 if month < today.month - 6 else 0)
    try:
        return date(year, month, int(m.group(1))).isoformat()
    except ValueError:
        return None


_DELIVERY_WHEN = re.compile(
    r"\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\s+"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|\d+\s*(-\s*\d+\s*)?days?)\b",
    re.I,
)


def _spec_key(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:60] or "spec"


def _spec_value(value: str) -> tuple[str | float, str | None]:
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([A-Za-z%]+)\s*", value)
    if m:
        n = float(m.group(1))
        return (int(n) if n.is_integer() else n), m.group(2)
    return value.strip(), None


def verify(
    raw: dict[str, Any], req: ExtractFallbackRequest, today: date
) -> ExtractFallbackResponse:
    page = _norm(req.text)
    wanted = _wanted(req.missing)
    currency = "INR"
    found: dict[str, Any] = {
        "title": None, "brand": None, "price": None, "rating": None, "availability": None,
        "category": None, "specs": {}, "delivery": None, "seller": None,
    }  # fmt: skip
    evidence: list[dict[str, str]] = []
    first: dict[str, dict[str, Any]] = {}

    for item in raw.get("items", []):
        field, snippet = item["field"], item["snippet"].strip()
        value = re.sub(r"\s+", " ", item["value"]).strip()
        value = re.sub(r"[.\s]*\bDetails$", "", value)  # Amazon's link text after delivery
        if field not in wanted or not value or not snippet:
            continue
        if _norm(snippet) not in page:
            log.info("extract: snippet not in page text: %r", snippet[:80])
            continue
        nums = numbers_in(value)
        if nums and not nums <= numbers_in(snippet):
            continue
        if not nums and _norm(value) not in _norm(snippet):
            continue
        if field == "spec":
            label = re.sub(r"\s+", " ", item.get("label") or "").strip()
            if not label or _norm(label) == _norm(value):
                continue  # a highlight line, not a "name: value" spec
            key = _spec_key(label)
            if key in found["specs"]:
                continue
            spec_value, unit = _spec_value(value)
            found["specs"][key] = {"label": label, "value": spec_value, "unit": unit}
            evidence.append({"field_path": f"specs.{key}", "snippet": snippet})
            continue
        if field == "delivery" and not _DELIVERY_WHEN.search(value):
            continue  # a promise needs a day or date; "Prime: FREE same-day delivery" is an ad
        if field == "seller":
            value = re.sub(r"^(sold by|seller)\s*:?\s*", "", value, flags=re.I)
        if field in first:
            continue  # the first occurrence wins; never merge competing values
        first[field] = {"value": value, "snippet": snippet}
        evidence.append({"field_path": FIELD_PATHS[field], "snippet": snippet})

    def take(field: str) -> str | None:
        return first[field]["value"] if field in first else None

    for field in ("title", "brand", "category", "seller"):
        found[field] = take(field)
    if "rating" in first and "rating_count" in first:
        value, count = _amount(first["rating"]["value"]), _amount(first["rating_count"]["value"])
        if value is not None and count is not None and 0 <= value <= 5:
            found["rating"] = {"value": value, "count": int(count)}
    if "availability" in first:
        text = first["availability"]["value"]
        low = text.lower()
        status = (
            "out_of_stock" if re.search(r"out of stock|unavailable|sold out", low)
            else "low_stock" if re.search(r"only \d+ left|few left|hurry", low)
            else "in_stock" if "in stock" in low
            else "unknown"
        )  # fmt: skip
        found["availability"] = {"status": status, "text": text}
    if "delivery" in first:
        text = first["delivery"]["value"]
        cost = None
        if "delivery_cost" in first or re.search(r"\bfree\b", text, re.I):
            cost_text = first.get("delivery_cost", {}).get("value", text)
            if re.search(r"\bfree\b", cost_text, re.I):
                cost = {"amount": 0, "currency": currency}
            elif (amount := _amount(cost_text)) is not None:
                cost = {"amount": amount, "currency": currency}
        found["delivery"] = {"text": text, "cost": cost, "date": _delivery_date(text, today)}

    covered = {e["field_path"] for e in evidence}

    def is_covered(path: str) -> bool:
        if path == "specs":
            return bool(found["specs"])
        top = path.split(".")[0]
        if found.get(top) in (None, {}):
            return False
        return any(
            c == path or c.startswith(path + ".") or path.startswith(c) or c.split(".")[0] == path
            for c in covered
        )

    still_missing = [m for m in req.missing if not is_covered(m)]
    # Keep evidence only for fields that made it into `found`.
    evidence = [
        e
        for e in evidence
        if e["field_path"].split(".")[0] in {k for k, v in found.items() if v not in (None, {})}
    ]
    return ExtractFallbackResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "found": found,
            "evidence": evidence,
            "missing": still_missing,
        }
    )


async def extract(
    req: ExtractFallbackRequest, today: date | None = None
) -> ExtractFallbackResponse:
    key = hashlib.sha256(f"{req.url}\n{req.text}\n{sorted(req.missing)}".encode()).hexdigest()[:16]
    cached = _cache.get(key)
    if cached is not None:
        return cached
    text = redact(req.text).text  # the device already redacts; this is a second line
    wanted = sorted(_wanted(req.missing))
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Fields asked for: {', '.join(wanted)}\nSite: {req.site}\n\n"
            f"PAGE TEXT:\n{text}",
        },
    ]
    cfg = LLMSettings.load()
    raw = await complete_json(
        f"extract/{key}",
        [cfg.fast_model, cfg.model],
        messages,
        OUTPUT_SCHEMA,
        name="page_facts",
        max_tokens=2500,
    )
    result = verify(raw, req, today or date.today())
    _cache.set(key, result)
    return result


def summarise_for_log(res: ExtractFallbackResponse) -> str:
    return json.dumps(
        {"found": [k for k, v in res.found.model_dump().items() if v], "missing": res.missing}
    )
