from app.services.cache import TTLCache


def test_ttl_cache_expires():
    now = [0.0]
    cache = TTLCache(ttl_seconds=10, clock=lambda: now[0])
    cache.set("k", 1)
    assert cache.get("k") == 1
    now[0] = 11
    assert cache.get("k") is None


def test_ttl_cache_evicts_least_recently_used_when_full():
    cache = TTLCache(ttl_seconds=10, max_entries=2)
    cache.set("a", 1)
    cache.set("b", 2)
    assert cache.get("a") == 1  # a is now the most recently used
    cache.set("c", 3)
    assert cache.get("b") is None
    assert cache.get("a") == 1 and cache.get("c") == 3
    assert len(cache) == 2


def test_ttl_cache_overwrite_does_not_grow():
    cache = TTLCache(ttl_seconds=10, max_entries=2)
    cache.set("a", 1)
    cache.set("a", 2)
    assert cache.get("a") == 2 and len(cache) == 1


def test_ttl_cache_clear():
    cache = TTLCache()
    cache.set("a", 1)
    cache.clear()
    assert cache.get("a") is None and len(cache) == 0
