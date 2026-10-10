"""Spoken-number normaliser (native digits, number words, lakh/crore) — Track A.

STUB: only converts native Devanagari and Telugu digits to ASCII.
"""

from __future__ import annotations

_DIGITS = str.maketrans("०१२३४५६७८९౦౧౨౩౪౫౬౭౮౯", "0123456789" * 2)


def normalise_digits(text: str) -> str:
    return text.translate(_DIGITS)
