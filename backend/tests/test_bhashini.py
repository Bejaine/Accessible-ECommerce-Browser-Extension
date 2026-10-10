import json

import pytest

from app.errors import ApiError
from app.services.bhashini import EXAMPLE_FILE, Limiter, Registry, TokenBucket, call_model


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


def test_registry_loads_example_shape():
    reg = Registry.from_dict(json.loads(EXAMPLE_FILE.read_text()))
    assert reg.keys("asr") == ["en", "hi", "te"]
    entry = reg.get("mt", "en-hi")
    assert entry.rpm == 60 and not entry.configured
    with pytest.raises(ApiError):
        reg.get("tts", "xx")


def test_registry_falls_back_to_example_when_local_missing(tmp_path):
    reg = Registry.load(tmp_path / "missing.json")
    assert reg.get("ocr", "default").rpm == 10


def test_token_bucket_enforces_rpm_and_refills():
    clock = FakeClock()
    bucket = TokenBucket(rpm=60, clock=clock)
    assert all(bucket.try_acquire() for _ in range(60))
    assert not bucket.try_acquire()
    clock.t += 1.0  # 60 rpm -> one token per second
    assert bucket.try_acquire()


async def test_limiter_raises_retryable_429_when_wait_too_long():
    clock = FakeClock()
    limiter = Limiter(max_wait_s=0.5, clock=clock)
    entry = Registry.from_dict({"ocr": {"default": {}}, "rpm": {"ocr": 1}}).get("ocr", "default")
    await limiter.acquire(entry)
    with pytest.raises(ApiError) as exc:
        await limiter.acquire(entry)
    assert exc.value.status == 429 and exc.value.retryable


async def test_call_model_in_mock_mode_never_needs_a_token():
    out = await call_model("asr", "hi", {})
    assert out["mock"] is True
