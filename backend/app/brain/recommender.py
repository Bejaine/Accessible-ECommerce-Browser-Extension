"""Deterministic recommender: hard filters, normalised weighted score; the LLM only explains.

Weights come from what the user asked for ("cheapest", "best rated", "good value"), never from
their disability profile (docs/product.md). Products missing a filtered field are excluded from
that filter's results rather than guessed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.models import ProductJSON

Prefer = Literal["cheapest", "best_rated", "balanced"]

WEIGHTS: dict[str, dict[str, float]] = {
    "cheapest": {"price": 0.8, "rating": 0.2},
    "best_rated": {"price": 0.2, "rating": 0.8},
    "balanced": {"price": 0.5, "rating": 0.5},
}


@dataclass
class Ranked:
    product: ProductJSON
    score: float


def rank(
    candidates: list[ProductJSON],
    prefer: Prefer = "balanced",
    *,
    max_price: float | None = None,
    min_rating: float | None = None,
) -> list[Ranked]:
    pool = [p for p in candidates if not p.sponsored]  # ads never win by default
    pool = pool or list(candidates)
    if max_price is not None:
        pool = [p for p in pool if p.price is not None and p.price.amount <= max_price]
    if min_rating is not None:
        pool = [p for p in pool if p.rating is not None and p.rating.value >= min_rating]
    if not pool:
        return []

    prices = [p.price.amount for p in pool if p.price is not None]
    ratings = [p.rating.value for p in pool if p.rating is not None]
    w = WEIGHTS[prefer]

    def norm(value: float | None, values: list[float], higher_is_better: bool) -> float:
        if value is None or not values:
            return 0.0  # unknown never helps
        lo, hi = min(values), max(values)
        if hi == lo:
            return 1.0
        x = (value - lo) / (hi - lo)
        return x if higher_is_better else 1 - x

    ranked = [
        Ranked(
            p,
            w["price"] * norm(p.price.amount if p.price else None, prices, False)
            + w["rating"] * norm(p.rating.value if p.rating else None, ratings, True),
        )
        for p in pool
    ]
    # Ties: more ratings first (more evidence), then page order (stable sort).
    ranked.sort(
        key=lambda r: (-round(r.score, 6), -(r.product.rating.count if r.product.rating else 0))
    )
    return ranked
