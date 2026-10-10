"""SerpApi read-only enrichment (rule 9, Track C). One amazon_product call per ASIN, cached.

With MOCK=1 responses come from fixtures/serpapi/amazon_product.<ASIN>.json.
"""

from __future__ import annotations

import json
from typing import Any

from app.config import get_settings
from app.errors import ApiError
from app.services.cache import TTLCache

_cache = TTLCache(ttl_seconds=24 * 3600)


async def amazon_product(asin: str) -> dict[str, Any]:
    cached = _cache.get(asin)
    if cached is not None:
        return cached
    settings = get_settings()
    if settings.mock:
        path = settings.fixtures_dir / "serpapi" / f"amazon_product.{asin}.json"
        if not path.exists():
            raise ApiError("not_found", f"No recorded SerpApi response for {asin}.", status=404)
        result = json.loads(path.read_text())
    else:
        raise ApiError("not_implemented", "Live SerpApi calls are not wired up yet.", status=501)
    _cache.set(asin, result)
    return result
