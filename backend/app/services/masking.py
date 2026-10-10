"""Mask brands, model names, units and prices before NMT and restore after (rule 7, Track A).

mask(text, keep=()) -> (masked_text, table); unmask(text, table) -> text; missing(text, table).

Placeholders are ZQX0, ZQX1, … — chosen by a live test against AnuvaadHub MT (2026-10-11):
⟦0⟧ made the model invent numbers, <0>, {0} and __0__ failed in some direction, ZQX0 survived
en→hi, en→te and hi→en in a natural position. The MT may still add spaces, change case or
use native digits, so unmask/missing parse placeholders loosely.

What is masked (one placeholder per phrase, so MT can't reorder its parts):
- links; terms the caller passes in `keep` (e.g. the product's brand, for "Apple", "Noise")
- prices: ₹1,299 / Rs. 1,299 / INR 999 / 1,299/-
- number + unit abbreviation: 5000 mAh, 45W, 12 GB, 2.4 GHz, 500 ml, 6.8 inch, 6.7"
- any other decimal (4.3): live MT rewrote "6.8" as "6.80" and "Bluetooth 5.3" as "5"
- names: words mixing letters and digits (S24, 5G, SM-A156B), unusual capitals (boAt, iPhone,
  OnePlus), acronyms (USB-C, HDMI), hyphenated capitals (Wi-Fi), capitalised words that don't
  start a sentence (Sony); neighbouring name words and numbers join one phrase
  ("Samsung Galaxy S24 Ultra 5G", "boAt Airdopes 141")
- in Hindi/Telugu text: every run of Latin-script words ("मुझे iPhone 15 Pro दिखाओ")
"""

from __future__ import annotations

import re
from collections.abc import Iterable

PREFIX = "ZQX"
_NATIVE_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯", "0123456789" * 2)
_PLACEHOLDER = re.compile(r"z\s*q\s*x\s*([0-9०-९౦-౯]+)", re.IGNORECASE)

_URL = re.compile(r"(?:https?://|www\.)\S+?(?=[.,!?)\]]*(?:\s|$))")
_PRICE = re.compile(
    r"(?:₹|Rs\.?|INR|USD|\$|€|£)\s?\d[\d,]*(?:\.\d+)?"  # ₹1,299  Rs. 1,299  INR 999
    r"|\b\d[\d,]*(?:\.\d+)?/-"  # 1,299/-
)
_UNITS = (
    "mAh|kWh|Wh|kW|W|V|Hz|kHz|MHz|GHz|TB|GB|MB|KB|mm|cm|km|m|kg|mg|g|ml|mL|L|l|MP|fps|nm|dB|"
    "ppi|nits|°C|°F|K"
)
_NUMBER_UNIT = re.compile(rf"\b\d+(?:[.,]\d+)?\s?(?:{_UNITS}|inch(?:es)?|\")(?![\w])")
# Live MT changed decimals ("6.8" -> "6.80", "Bluetooth 5.3" -> "5"); whole numbers survived.
_DECIMAL = re.compile(r"\b\d+\.\d+\b")
_NAME = re.compile(
    r"\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\b"  # S24, 5G, SM-A156B
    r"|\b[A-Z]{2,}(?:-[A-Z0-9]+)*\b"  # USB-C, HDMI
    r"|\b[a-z]+[A-Z][A-Za-z]*\b|\b[A-Z][a-z]+[A-Z][A-Za-z]*\b"  # boAt, iPhone, OnePlus
    r"|\b[A-Z][a-z]*-[A-Z][A-Za-z]*\b"  # Wi-Fi, Type-C
)
_CAPITALISED = re.compile(r"\b[A-Z][a-z]+\b")
_NUMBER = re.compile(r"\b\d+(?:\.\d+)?\b")
_LATIN_RUN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+/-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9.+/-]*)*")
_INDIC = re.compile(r"[ऀ-ॿఀ-౿]")
_SENTENCE_END = re.compile(r"(?:^|[.!?।\n])[\s\"'“‘(]*$")

Span = tuple[int, int]


def mask(text: str, keep: Iterable[str] = ()) -> tuple[str, dict[str, str]]:
    spans: list[Span] = []

    def claim(start: int, end: int) -> None:
        if start < end and all(end <= s or start >= e for s, e in spans):
            spans.append((start, end))

    for pattern in (_URL, *(_keep_pattern(k) for k in keep if k.strip()), _PRICE, _NUMBER_UNIT):
        for m in pattern.finditer(text):
            claim(m.start(), m.end())

    if _INDIC.search(text):
        for m in _LATIN_RUN.finditer(text):
            if re.search(r"[A-Za-z]", m.group()):
                claim(m.start(), m.end())
    else:
        for start, end in _name_phrases(text, spans):
            claim(start, end)
    for m in _DECIMAL.finditer(text):  # after names, so "Bluetooth 5.3" stays one phrase
        claim(m.start(), m.end())

    table: dict[str, str] = {}
    out: list[str] = []
    last = 0
    for i, (start, end) in enumerate(sorted(spans)):
        key = f"{PREFIX}{i}"
        table[key] = text[start:end]
        out += [text[last:start], key]
        last = end
    out.append(text[last:])
    return "".join(out), table


def unmask(text: str, table: dict[str, str]) -> str:
    """Restore originals in one pass, so a restored text is never substituted again."""

    def restore(m: re.Match[str]) -> str:
        return table.get(f"{PREFIX}{m.group(1).translate(_NATIVE_DIGITS)}", m.group())

    return _PLACEHOLDER.sub(restore, text)


def placeholders(text: str) -> list[str]:
    """The placeholders in `text`, normalised (ZQX 0, zqx0 and ZQX० are all "ZQX0")."""
    return [f"{PREFIX}{m.group(1).translate(_NATIVE_DIGITS)}" for m in _PLACEHOLDER.finditer(text)]


def missing(text: str, table: dict[str, str | None]) -> list[str]:
    """Placeholders from `table` that the translated `text` no longer contains."""
    found = set(placeholders(text))
    return [key for key in table if key not in found]


def _keep_pattern(term: str) -> re.Pattern[str]:
    return re.compile(rf"(?<!\w){re.escape(term.strip())}(?!\w)")


def _name_phrases(text: str, taken: list[Span]) -> list[Span]:
    """Name words (and numbers next to them) separated by single spaces form one phrase."""

    items: dict[Span, bool] = {}  # span -> is a name (numbers only join a phrase)

    def free(start: int, end: int) -> bool:
        return all(end <= s or start >= e for s, e in [*taken, *items])

    for m in _NAME.finditer(text):
        if free(m.start(), m.end()):
            items[(m.start(), m.end())] = True
    for m in _CAPITALISED.finditer(text):  # "Wi" and "Fi" inside "Wi-Fi" are skipped
        if free(m.start(), m.end()) and not _SENTENCE_END.search(text[: m.start()]):
            items[(m.start(), m.end())] = True
    for m in _NUMBER.finditer(text):
        if free(m.start(), m.end()):
            items[(m.start(), m.end())] = False

    phrases: list[Span] = []
    chain: list[tuple[Span, bool]] = []

    def flush() -> None:
        if any(is_name for _, is_name in chain):
            phrases.append((chain[0][0][0], chain[-1][0][1]))
        chain.clear()

    for span, is_name in sorted(items.items()):
        if chain and text[chain[-1][0][1] : span[0]] != " ":
            flush()
        chain.append((span, is_name))
    flush()
    return phrases
