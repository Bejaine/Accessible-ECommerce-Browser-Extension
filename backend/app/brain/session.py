"""Per-session memory for /turn, in this process only, expiring after 30 idle minutes.

Holds: products the shopper looked at (to compare across pages and sites), the preferences
they STATED ("camera matters, battery doesn't"), and consecutive misses (for the "never ask a
third time" rule). Nothing is inferred and nothing outlives the session (rule 8: the profile
lives on the device; the backend keeps only what one session needs).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from app.models import ProductJSON
from app.services.cache import TTLCache

MAX_SEEN = 8
IMPORTANCE = {"must": 1.0, "high": 1.0, "medium": 0.6, "low": 0.25, "ignore": 0.0}


@dataclass
class Session:
    misses: int = 0
    seen: dict[str, ProductJSON] = field(default_factory=dict)  # id -> product, oldest first
    priorities: dict[str, float] = field(default_factory=dict)  # feature -> weight 0-1
    max_price: float | None = None
    min_rating: float | None = None
    workflow: dict | None = None  # the order task in progress (brain/workflows.py)

    def remember(self, product: ProductJSON) -> None:
        self.seen.pop(product.id, None)
        self.seen[product.id] = product
        while len(self.seen) > MAX_SEEN:
            self.seen.pop(next(iter(self.seen)))

    def state(self, priorities: list[dict] | None, max_price=None, min_rating=None) -> None:
        """Merge what the shopper just said into what they said before."""
        for p in priorities or []:
            feature, importance = p.get("feature"), p.get("importance")
            if feature and importance in IMPORTANCE:
                self.priorities[feature] = IMPORTANCE[importance]
        if max_price is not None:
            self.max_price = float(max_price)
        if min_rating is not None:
            self.min_rating = float(min_rating)


_store = TTLCache(ttl_seconds=1800)


def get(session_id: str) -> Session:
    s = _store.get(session_id)
    if s is None:
        s = Session()
    _store.set(session_id, s)  # touching it keeps it alive
    return s


def reset() -> None:
    """Tests only."""
    global _store
    _store = TTLCache(ttl_seconds=1800)
