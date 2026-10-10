from app.services.cache import TTLCache


def test_ttl_cache_expires():
    now = [0.0]
    cache = TTLCache(ttl_seconds=10, clock=lambda: now[0])
    cache.set("k", 1)
    assert cache.get("k") == 1
    now[0] = 11
    assert cache.get("k") is None
