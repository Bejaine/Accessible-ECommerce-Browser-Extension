"""Grounding check (rule 1): drop every claim that has no matching field.

A grounding entry is kept only if its field_path resolves to a non-null value on the named
subject (ProductJSON / OrderJSON id) and the claim agrees with that value: every number in
the claim appears in the value, or (for claims without numbers) the claim shares a word with
it. Items pointing at a dropped entry are dropped. Free text (summary, simpler, table cells,
spoken tables, warnings) may only contain numbers that appear in a kept value or that the
calling code computed itself (`derived`, e.g. a count of results); sentences that don't pass
are removed.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from app.models import AccessibleOutput

NOT_LISTED = "not listed"
FALLBACK_SUMMARY = "Here is what the page lists."

_NUMBER = re.compile(r"\d+(?:,\d+)*(?:\.\d+)?")
_PATH_PART = re.compile(r"([^.\[\]]+)|\[(\d+)\]")
_OUT_OF = re.compile(r"\b(out of|/)\s*5\b", re.IGNORECASE)
_SENTENCE = re.compile(r"(?<=[.!?।])\s+")
_WORD = re.compile(r"[a-z]{3,}")
_STOPWORDS = {"the", "and", "for", "with", "this", "that", "are", "from", "has", "have", "its"}


class Unresolved(Exception):
    pass


def resolve(subject: Any, path: str) -> Any:
    """Follow a dot path such as `reviews.items[3].text` or `reviews.histogram.5`."""
    value = subject
    for name, index in _PATH_PART.findall(path):
        try:
            value = value[int(index)] if index else value[name]
        except (KeyError, IndexError, TypeError) as exc:
            raise Unresolved(path) from exc
    if not path or value is None:
        raise Unresolved(path)
    return value


def numbers_in(text: str) -> set[float]:
    return {round(float(n.replace(",", "")), 2) for n in _NUMBER.findall(text)}


def _value_numbers(value: Any) -> set[float]:
    if isinstance(value, bool):
        return set()
    if isinstance(value, int | float):
        return {round(float(value), 2)}
    if isinstance(value, str):
        return numbers_in(value)
    if isinstance(value, Mapping):
        return set().union(*map(_value_numbers, value.values())) if value else set()
    if isinstance(value, list | tuple):
        return set().union(*map(_value_numbers, value)) if value else set()
    return set()


def _value_words(value: Any) -> set[str]:
    if isinstance(value, bool):
        return {"yes", "true"} if value else {"no", "false", "not"}
    if isinstance(value, str):
        return set(_WORD.findall(value.lower().replace("_", " "))) - _STOPWORDS
    if isinstance(value, Mapping):
        return set().union(*map(_value_words, value.values())) if value else set()
    if isinstance(value, list | tuple):
        return set().union(*map(_value_words, value)) if value else set()
    return set()


def claim_matches(claim: str, value: Any, ignore: set[float] = frozenset()) -> bool:
    """`ignore`: numbers that are part of a name (the 5 in "Pulse 5G"), not claims."""
    if isinstance(value, str) and claim.strip().lower() == value.strip().lower():
        return True
    nums = numbers_in(_OUT_OF.sub("", claim)) - ignore
    if nums:
        return nums <= _value_numbers(value)
    words = set(_WORD.findall(claim.lower())) - _STOPWORDS
    return any(_same_word(a, b) for a in words for b in _value_words(value))


def _same_word(a: str, b: str) -> bool:
    """Equal, or sharing a stem of 4+ letters: heat/heating, display/displays."""
    return a == b or (min(len(a), len(b)) >= 4 and (a.startswith(b) or b.startswith(a)))


@dataclass
class CheckResult:
    output: AccessibleOutput
    dropped: list[str] = field(default_factory=list)
    derived: set[float] = field(default_factory=set)


def check(
    output: AccessibleOutput,
    subjects: Mapping[str, Any],
    derived: Iterable[float] = (),
) -> CheckResult:
    """Return a copy of `output` with every unsupported claim removed, plus what was dropped.

    `subjects` maps ProductJSON/OrderJSON ids to their data (models or dicts).
    """
    data = output.model_dump(mode="json")
    plain = {
        k: (v.model_dump(mode="json", by_alias=True) if hasattr(v, "model_dump") else v)
        for k, v in subjects.items()
    }
    dropped: list[str] = []

    remap: dict[int, int] = {}
    kept: list[dict[str, Any]] = []
    values: list[Any] = []
    for i, g in enumerate(data["grounding"]):
        try:
            value = resolve(plain[g["subject_id"]], g["field_path"])
        except (KeyError, Unresolved):
            dropped.append(f"no field {g['subject_id']} {g['field_path']}: {g['claim']}")
            continue
        if not claim_matches(g["claim"], value):
            dropped.append(f"claim does not match {g['field_path']}: {g['claim']}")
            continue
        remap[i] = len(kept)
        kept.append(g)
        values.append(value)

    allowed = set().union(*map(_value_numbers, values)) if values else set()
    derived = {round(float(n), 2) for n in derived}
    allowed |= derived

    def supported(text: str) -> bool:
        return numbers_in(_OUT_OF.sub("", text)) <= allowed

    def clean_text(text: str | None) -> str | None:
        if text is None:
            return None
        sentences = [s for s in _SENTENCE.split(text) if s]
        good = [s for s in sentences if supported(s)]
        dropped.extend(f"unsupported number in: {s}" for s in sentences if s not in good)
        return " ".join(good) or None

    for section in data["sections"]:
        items = []
        for item in section["items"]:
            gi = item["grounding_index"]
            if gi is not None:
                if gi not in remap:
                    dropped.append(f"item lost its grounding: {item['text']}")
                    continue
                own = _value_numbers(values[remap[gi]]) | allowed
                if not numbers_in(_OUT_OF.sub("", item["text"])) <= own:
                    dropped.append(f"item number not in its field: {item['text']}")
                    continue
                item["grounding_index"] = remap[gi]
            elif not supported(item["text"]):
                dropped.append(f"ungrounded item: {item['text']}")
                continue
            items.append(item)
        section["items"] = items
        section["simpler"] = clean_text(section["simpler"])
        table = section["table"]
        if table is not None:
            for row in table["rows"]:
                for j, cell in enumerate(row):
                    if not supported(cell):
                        dropped.append(f"ungrounded cell: {cell}")
                        row[j] = NOT_LISTED
            table["spoken"] = clean_text(table["spoken"]) or ""

    data["sections"] = [s for s in data["sections"] if s["items"] or s["table"]]
    data["grounding"] = kept
    data["summary"] = clean_text(data["summary"]) or FALLBACK_SUMMARY
    data["simpler"] = clean_text(data["simpler"])
    data["warnings"] = [w for w in data["warnings"] if supported(w)]
    return CheckResult(AccessibleOutput.model_validate(data), dropped, derived)
