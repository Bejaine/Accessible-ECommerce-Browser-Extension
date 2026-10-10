"""Mask brands, model names, units and prices before NMT and restore after (rule 7, Track A).

STUB: identity masking. The contract is mask() -> (masked_text, table) and unmask(text, table).
"""

from __future__ import annotations


def mask(text: str) -> tuple[str, dict[str, str]]:
    return text, {}


def unmask(text: str, table: dict[str, str]) -> str:
    for placeholder, original in table.items():
        text = text.replace(placeholder, original)
    return text
