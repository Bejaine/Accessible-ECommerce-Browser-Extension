"""Deterministic recommender: hard filters, normalised weighted score; the LLM only explains.

STUB: returns candidates unchanged.
"""

from __future__ import annotations

from app.models import ProductJSON


def rank(candidates: list[ProductJSON], _weights: dict[str, float]) -> list[ProductJSON]:
    return list(candidates)
