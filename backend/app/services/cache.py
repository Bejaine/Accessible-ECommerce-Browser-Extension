"""In-process TTL cache (Track A). STUB: a dict with expiry; swap for something sturdier later."""

from __future__ import annotations

import time
from typing import Any


class TTLCache:
    def __init__(self, ttl_seconds: float = 3600, clock=time.monotonic):
        self._ttl = ttl_seconds
        self._clock = clock
        self._data: dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Any | None:
        hit = self._data.get(key)
        if hit is None:
            return None
        expires, value = hit
        if self._clock() >= expires:
            del self._data[key]
            return None
        return value

    def set(self, key: str, value: Any) -> None:
        self._data[key] = (self._clock() + self._ttl, value)
