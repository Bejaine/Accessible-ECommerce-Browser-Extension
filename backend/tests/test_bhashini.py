import asyncio
import base64
import io
import json
import wave

import httpx
import pytest

from app.errors import ApiError
from app.models import ErrorCode
from app.services import bhashini
from app.services.bhashini import (
    EXAMPLE_FILE,
    Limiter,
    Registry,
    TokenBucket,
    call_model,
    map_upstream_status,
)


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t


class FakeSleep:
    """Advances the fake clock instead of sleeping, and records each wait."""

    def __init__(self, clock: FakeClock) -> None:
        self.clock = clock
        self.waits: list[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)
        self.clock.t += seconds


@pytest.fixture(autouse=True)
def _isolated_gateway(monkeypatch):
    """Never load models.local.json in tests: real tokens must not reach a test run."""
    monkeypatch.setattr(bhashini, "_registry", Registry.load(EXAMPLE_FILE))
    bhashini.clear_caches()


def entry(task="ocr", key="default", rpm=1, **cfg):
    return Registry.from_dict({task: {key: cfg}, "rpm": {task: rpm}}).get(task, key)


# --- Registry ---------------------------------------------------------------------------


def test_registry_loads_example_shape():
    reg = Registry.from_dict(json.loads(EXAMPLE_FILE.read_text()))
    assert reg.keys("asr") == ["en", "hi", "ml", "te", "ur"]
    assert reg.keys("mt") == [
        "en-hi",
        "en-ml",
        "en-te",
        "en-ur",
        "hi-en",
        "ml-en",
        "te-en",
        "ur-en",
    ]
    assert reg.keys("tts") == ["en", "hi", "ml", "te", "ur"]
    assert reg.keys("ocr") == ["en", "hi", "te"]
    e = reg.get("mt", "en-hi")
    assert e.rpm == 50 and not e.configured


def test_registry_unknown_model_is_a_validation_error():
    reg = Registry.from_dict(json.loads(EXAMPLE_FILE.read_text()))
    with pytest.raises(ApiError) as exc:
        reg.get("tts", "xx")
    assert exc.value.code == ErrorCode.validation and exc.value.status == 400


def test_registry_falls_back_to_example_when_local_missing(tmp_path):
    reg = Registry.load(tmp_path / "missing.json")
    assert reg.get("ocr", "en").rpm == 50


def test_registry_per_model_rpm_overrides_task_default():
    reg = Registry.from_dict(
        {"asr": {"hi": {"rpm": 12}, "en": {}}, "rpm": {"asr": 30}},
    )
    assert reg.get("asr", "hi").rpm == 12
    assert reg.get("asr", "en").rpm == 30


def test_registry_configured_needs_url_and_token():
    assert entry(url="https://x", token="t").configured
    assert not entry(url="https://x").configured
    assert not entry(token="t").configured


def test_registry_rejects_malformed_keys():
    with pytest.raises(ValueError, match="mt"):
        Registry.from_dict({"mt": {"hindi": {}}})
    with pytest.raises(ValueError, match="asr"):
        Registry.from_dict({"asr": {"en-hi": {}}})
    with pytest.raises(ValueError, match="rpm"):
        Registry.from_dict({"asr": {"en": {}}, "rpm": {"asr": 0}})


def test_registry_never_shows_token_in_repr():
    e = entry(url="https://x", token="SECRET-TOKEN")
    assert "SECRET-TOKEN" not in repr(e)


def test_mt_route_is_direct_when_pair_exists():
    reg = Registry.from_dict(json.loads(EXAMPLE_FILE.read_text()))
    assert [e.key for e in reg.mt_route("en", "hi")] == ["en-hi"]


def test_mt_route_pivots_through_english():
    reg = Registry.from_dict(json.loads(EXAMPLE_FILE.read_text()))
    assert [e.key for e in reg.mt_route("hi", "te")] == ["hi-en", "en-te"]


def test_mt_route_same_language_needs_no_model():
    reg = Registry.from_dict({})
    assert reg.mt_route("hi", "hi") == []


def test_mt_route_missing_pair_is_a_validation_error():
    reg = Registry.from_dict({"mt": {"en-hi": {}}})
    with pytest.raises(ApiError) as exc:
        reg.mt_route("te", "hi")
    assert exc.value.code == ErrorCode.validation


# --- Token bucket and limiter -----------------------------------------------------------


def test_token_bucket_enforces_rpm_and_refills():
    clock = FakeClock()
    bucket = TokenBucket(rpm=60, clock=clock)
    assert all(bucket.try_acquire() for _ in range(60))
    assert not bucket.try_acquire()
    clock.t += 1.0  # 60 rpm -> one token per second
    assert bucket.try_acquire()


def test_token_bucket_never_exceeds_capacity():
    clock = FakeClock()
    bucket = TokenBucket(rpm=2, clock=clock)
    clock.t += 3600
    assert bucket.try_acquire() and bucket.try_acquire()
    assert not bucket.try_acquire()


BURST_60 = 15  # the limiter's bucket for a 60-rpm model holds rpm/4 tokens


def test_limiter_burst_keeps_any_minute_within_125_percent_of_rpm():
    """A full bucket of rpm/4 plus a minute of refill: at most 1.25 x rpm in any 60 s, where a
    full rpm-sized bucket would allow 2 x rpm and risk upstream 429s."""
    clock = FakeClock()
    limiter = Limiter(clock=clock)
    for rpm, burst in [(60, 15), (30, 7), (10, 2), (2, 1)]:
        bucket = limiter.bucket(entry(key=f"k{rpm}", rpm=rpm))
        assert bucket.capacity == burst
        sent = 0
        while clock.t < 60:
            if bucket.try_acquire():
                sent += 1
            clock.t += 0.01
        assert sent <= 1.25 * rpm + 1
        clock.t = 0


async def test_limiter_waits_briefly_for_a_token():
    clock = FakeClock()
    sleep = FakeSleep(clock)
    limiter = Limiter(max_wait_s=2.0, clock=clock, sleep=sleep)
    e = entry(rpm=60)
    for _ in range(BURST_60):
        await limiter.acquire(e)
    assert sleep.waits == []
    await limiter.acquire(e)
    assert sleep.waits == [pytest.approx(1.0)]


async def test_limiter_raises_retryable_429_when_wait_too_long():
    clock = FakeClock()
    limiter = Limiter(max_wait_s=0.5, clock=clock, sleep=FakeSleep(clock))
    e = entry(rpm=1)
    await limiter.acquire(e)
    with pytest.raises(ApiError) as exc:
        await limiter.acquire(e)
    assert exc.value.status == 429 and exc.value.retryable
    assert exc.value.code == ErrorCode.rate_limited


async def test_limiter_queues_concurrent_waiters_without_overspending():
    """Waiters reserve their slot, so three callers on an empty 60-rpm bucket wait 1 s, 2 s, 3 s."""
    clock = FakeClock()
    waits: list[float] = []

    async def sleep(seconds: float) -> None:  # record only; don't move the shared clock
        waits.append(seconds)
        await asyncio.sleep(0)

    limiter = Limiter(max_wait_s=10.0, clock=clock, sleep=sleep)
    e = entry(rpm=60)
    for _ in range(BURST_60):
        await limiter.acquire(e)
    await asyncio.gather(*(limiter.acquire(e) for _ in range(3)))
    assert sorted(waits) == [pytest.approx(1.0), pytest.approx(2.0), pytest.approx(3.0)]


async def test_limiter_rejected_caller_does_not_consume_a_slot():
    clock = FakeClock()
    sleep = FakeSleep(clock)
    limiter = Limiter(max_wait_s=0.5, clock=clock, sleep=sleep)
    e = entry(rpm=60)
    for _ in range(BURST_60):
        await limiter.acquire(e)
    with pytest.raises(ApiError):
        await limiter.acquire(e)  # needs 1 s > 0.5 s: rejected
    clock.t += 1.0
    await limiter.acquire(e)  # the rejected call reserved nothing, so a token is ready now
    assert sleep.waits == []


async def test_limiter_keeps_one_bucket_per_model():
    clock = FakeClock()
    limiter = Limiter(max_wait_s=0.0, clock=clock, sleep=FakeSleep(clock))
    reg = Registry.from_dict({"asr": {"hi": {}, "te": {}}, "rpm": {"asr": 1}})
    await limiter.acquire(reg.get("asr", "hi"))
    await limiter.acquire(reg.get("asr", "te"))  # separate bucket, not rate limited
    with pytest.raises(ApiError):
        await limiter.acquire(reg.get("asr", "hi"))


# --- Error mapping ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("status", "code", "retryable"),
    [
        (401, ErrorCode.auth_expired, False),
        (403, ErrorCode.auth_expired, False),
        (429, ErrorCode.rate_limited, True),
        (408, ErrorCode.upstream_unavailable, True),
        (500, ErrorCode.upstream_unavailable, True),
        (503, ErrorCode.upstream_unavailable, True),
        (400, ErrorCode.internal, False),
        (422, ErrorCode.internal, False),
    ],
)
def test_upstream_status_maps_to_error_code(status, code, retryable):
    err = map_upstream_status(status)
    assert err.code == code and err.retryable is retryable
    assert "token" not in err.message.lower()


# --- call_model and the response envelope -----------------------------------------------


def ok(data: dict) -> dict:
    return {"status": "success", "message": "ok", "data": data, "error": None, "code": 200}


def wav_bytes(seconds: float = 0.1, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(seconds * rate))
    return buf.getvalue()


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


async def test_call_model_in_mock_mode_unwraps_fixture_envelope():
    out = await call_model("asr", "hi")
    assert out["recognized_text"]


async def test_call_model_missing_mock_fixture_is_an_error(monkeypatch, tmp_path):
    monkeypatch.setenv("FIXTURES_DIR", str(tmp_path))
    with pytest.raises(ApiError) as exc:
        await call_model("asr", "hi")
    assert exc.value.code == ErrorCode.internal


@pytest.mark.parametrize(
    ("envelope", "code"),
    [
        ({"status": "failure", "data": None, "error": "bad token", "code": 401}, "auth_expired"),
        ({"status": "failure", "data": None, "error": "slow down", "code": 429}, "rate_limited"),
        ({"status": "failure", "data": None, "error": "boom", "code": 500}, "upstream_unavailable"),
        ({"status": "failure", "data": None, "error": "too long", "code": 400}, "internal"),
        ({"status": "success", "data": None, "error": None, "code": 200}, "upstream_unavailable"),
        ({"status": "success", "data": {}, "error": "odd", "code": 200}, "upstream_unavailable"),
        (["not", "an", "object"], "upstream_unavailable"),
    ],
)
async def test_failure_envelope_with_http_200_is_mapped(monkeypatch, envelope, code):
    _live(monkeypatch, lambda req: httpx.Response(200, json=envelope))
    with pytest.raises(ApiError) as exc:
        await call_model("mt", "en-hi", {"input_text": "hi"})
    assert exc.value.code == ErrorCode(code)


def _live(monkeypatch, handler, **cfg):
    """Real mode against an in-process fake upstream (also serves S3 and image downloads)."""
    monkeypatch.setenv("MOCK", "0")
    model = {"token": "T0K", **cfg}
    reg = Registry.from_dict(
        {
            "asr": {"hi": {"url": "https://up.example/asr", **model}},
            "mt": {"en-hi": {"url": "https://up.example/mt", **model}},
            "tts": {"hi": {"url": "https://up.example/tts", **model}},
            "ocr": {
                "en": {"url": "https://up.example/ocr-en", **model},
                "hi": {"url": "https://up.example/ocr-hi", **model},
            },
        }
    )
    monkeypatch.setattr(bhashini, "_registry", reg)
    monkeypatch.setattr(bhashini, "_limiter", Limiter())
    monkeypatch.setattr(bhashini, "_transport", httpx.MockTransport(handler))


async def test_call_model_live_sends_access_token_header_and_json(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["token"] = req.headers.get("access-token")
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json=ok({"output_text": "नमस्ते"}))

    _live(monkeypatch, handler)
    assert await call_model("mt", "en-hi", {"input_text": "hello"}) == {"output_text": "नमस्ते"}
    assert seen == {"token": "T0K", "body": {"input_text": "hello"}}


async def test_call_model_live_uses_configured_auth_header(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["key"] = req.headers.get("x-api-key")
        return httpx.Response(200, json=ok({}))

    _live(monkeypatch, handler, auth_header="X-API-Key")
    await call_model("mt", "en-hi", {})
    assert seen["key"] == "T0K"


async def test_call_model_live_maps_http_401_to_auth_expired(monkeypatch):
    _live(monkeypatch, lambda req: httpx.Response(401, json={"detail": "expired"}))
    with pytest.raises(ApiError) as exc:
        await call_model("mt", "en-hi", {})
    assert exc.value.code == ErrorCode.auth_expired


async def test_call_model_live_maps_timeout_to_upstream_unavailable(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=req)

    _live(monkeypatch, handler)
    with pytest.raises(ApiError) as exc:
        await call_model("mt", "en-hi", {})
    assert exc.value.code == ErrorCode.upstream_unavailable and exc.value.retryable


async def test_call_model_live_non_json_body_is_upstream_unavailable(monkeypatch):
    _live(monkeypatch, lambda req: httpx.Response(200, text="<html>oops</html>"))
    with pytest.raises(ApiError) as exc:
        await call_model("mt", "en-hi", {})
    assert exc.value.code == ErrorCode.upstream_unavailable


async def test_call_model_live_without_token_is_unavailable(monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setattr(bhashini, "_registry", Registry.from_dict({"asr": {"hi": {}}}))
    with pytest.raises(ApiError) as exc:
        await call_model("asr", "hi")
    assert exc.value.code == ErrorCode.upstream_unavailable and not exc.value.retryable


# --- ASR --------------------------------------------------------------------------------


async def test_asr_live_uploads_wav_as_audio_file_form_field(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["type"] = req.headers["content-type"]
        seen["body"] = req.content
        return httpx.Response(200, json=ok({"recognized_text": " isse cart mein daal do "}))

    _live(monkeypatch, handler)
    audio = wav_bytes()
    res = await bhashini.asr("hi", audio_base64=b64(audio), encoding="wav")
    assert res == bhashini.AsrResult("isse cart mein daal do", None, [])
    assert seen["type"].startswith("multipart/form-data")
    assert b'name="audio_file"; filename="audio.wav"' in seen["body"]
    assert b"Content-Type: audio/wav" in seen["body"] and audio in seen["body"]


@pytest.mark.parametrize("lang", ["en", "hi", "te"])
async def test_asr_mock_round_trip_every_language(lang):
    assert (await bhashini.asr(lang, audio_base64=b64(wav_bytes()), encoding="wav")).text


@pytest.mark.parametrize(
    ("audio", "encoding", "why"),
    [
        (wav_bytes(), "webm", "WAV"),
        (b"RIFF-not-really", "wav", "readable WAV"),
        (wav_bytes(seconds=21, rate=8000), "wav", "20 seconds"),
    ],
)
async def test_asr_rejects_what_the_service_cannot_take(audio, encoding, why):
    with pytest.raises(ApiError, match=why) as exc:
        await bhashini.asr("hi", audio_base64=b64(audio), encoding=encoding)
    assert exc.value.code == ErrorCode.validation


async def test_asr_rejects_files_of_5mb_or_more():
    big = wav_bytes(seconds=0.01) + b"\0" * bhashini.MAX_UPLOAD_BYTES
    with pytest.raises(ApiError, match="5 MB"):
        await bhashini.asr("hi", audio_base64=b64(big), encoding="wav")


async def test_asr_rejects_invalid_base64():
    with pytest.raises(ApiError, match="base64"):
        await bhashini.asr("hi", audio_base64="not base64!!", encoding="wav")


# --- MT ---------------------------------------------------------------------------------


async def test_translate_live_sends_input_text_and_reads_output_text(monkeypatch):
    def handler(req: httpx.Request) -> httpx.Response:
        assert json.loads(req.content) == {"input_text": "Battery capacity is 5000 mAh."}
        return httpx.Response(200, json=ok({"output_text": "बैटरी क्षमता 5000 mAh है।"}))

    _live(monkeypatch, handler)
    out = await bhashini.translate("Battery capacity is 5000 mAh.", "en", "hi")
    assert out == "बैटरी क्षमता 5000 mAh है।"


async def test_translate_splits_long_text_into_50_word_chunks(monkeypatch):
    sent = []

    def handler(req: httpx.Request) -> httpx.Response:
        text = json.loads(req.content)["input_text"]
        sent.append(text)
        return httpx.Response(200, json=ok({"output_text": f"T{len(sent)}"}))

    _live(monkeypatch, handler)
    sentences = [" ".join([f"w{i}"] * 19) + " end." for i in range(6)]  # 6 x 20 words
    out = await bhashini.translate(" ".join(sentences), "en", "hi")
    assert [len(s.split()) for s in sent] == [40, 40, 40]  # whole sentences, each <= 50
    assert out == "T1 T2 T3"


async def test_translate_caches_chunks_so_repeats_cost_no_calls(monkeypatch):
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json=ok({"output_text": "T"}))

    _live(monkeypatch, handler)
    await bhashini.translate("Battery is good.", "en", "hi")
    await bhashini.translate("Battery is good.", "en", "hi")
    assert len(calls) == 1


async def test_translate_same_language_makes_no_call(monkeypatch):
    async def boom(*a, **k):
        raise AssertionError("should not call a model")

    monkeypatch.setattr(bhashini, "call_model", boom)
    assert await bhashini.translate("hello", "en", "en") == "hello"


async def test_translate_pivots_hi_to_te_through_english(monkeypatch):
    calls = []
    real = bhashini.call_model

    async def spy(task, key, json_body=None, **kw):
        calls.append(key)
        return await real(task, key, json_body, **kw)

    monkeypatch.setattr(bhashini, "call_model", spy)
    assert await bhashini.translate("बैटरी क्षमता: ZQX0", "hi", "te")
    assert calls == ["hi-en", "en-te"]


@pytest.mark.parametrize(
    ("words", "limit", "sizes"),
    [
        ("a b c. d e. f g h i.", 5, [5, 4]),
        ("a b c d e f g h i j k l", 5, [5, 5, 2]),  # one long sentence is cut
        ("एक दो। तीन चार। पाँच", 4, [4, 1]),  # Devanagari danda ends a sentence
        ("", 5, []),
    ],
)
def test_chunk_words(words, limit, sizes):
    assert [len(c.split()) for c in bhashini.chunk_words(words, limit)] == sizes


# --- TTS --------------------------------------------------------------------------------


async def test_tts_live_posts_text_and_gender_then_fetches_s3_wav(monkeypatch):
    audio = wav_bytes()
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "up.example":
            seen["body"] = json.loads(req.content)
            return httpx.Response(200, json=ok({"s3_url": "https://s3.example/out.wav"}))
        seen["download_token"] = req.headers.get("access-token")
        return httpx.Response(200, content=audio)

    _live(monkeypatch, handler)
    res = await bhashini.tts("Added to cart.", "hi", voice="male")
    assert seen["body"] == {"text": "Added to cart.", "gender": "male"}
    assert seen["download_token"] is None  # never send our token to S3
    assert res == bhashini.TtsResult(audio_base64=b64(audio), encoding="wav")


async def test_tts_splits_long_text_and_joins_the_wavs(monkeypatch):
    texts = []

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "up.example":
            texts.append(json.loads(req.content)["text"])
            return httpx.Response(200, json=ok({"s3_url": "https://s3.example/x.wav"}))
        return httpx.Response(200, content=wav_bytes(seconds=0.5))

    _live(monkeypatch, handler)
    res = await bhashini.tts(" ".join(["word"] * 70), "hi")
    assert [len(t.split()) for t in texts] == [30, 30, 10]
    with wave.open(io.BytesIO(base64.b64decode(res.audio_base64))) as w:
        assert w.getnframes() == 3 * 8000  # three 0.5 s chunks at 16 kHz


@pytest.mark.parametrize(
    ("text", "clean"),
    [
        ("Price: ₹1,299 (incl. GST)!", "Price 1,299 incl. GST !"),
        ("Don't miss *this* deal — 50% off", "Dont miss this deal 50 off"),
        ("बैटरी क्षमता: 5000 mAh।", "बैटरी क्षमता 5000 mAh।"),
        ("దీన్ని కార్ట్‌లో వేయండి", "దీన్ని కార్ట్ లో వేయండి"),
    ],
)
def test_tts_clean_text_drops_special_characters_but_keeps_scripts(text, clean):
    assert bhashini.tts_clean_text(text) == clean


async def test_tts_with_nothing_speakable_is_a_validation_error():
    with pytest.raises(ApiError) as exc:
        await bhashini.tts("*** ---", "hi")
    assert exc.value.code == ErrorCode.validation


@pytest.mark.parametrize("lang", ["en", "hi", "te"])
async def test_tts_mock_round_trip_every_language(lang):
    res = await bhashini.tts("hello", lang)
    with wave.open(io.BytesIO(base64.b64decode(res.audio_base64))) as w:
        assert w.getnframes() > 0


async def test_tts_unknown_voice_falls_back_to_female(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "up.example":
            seen["gender"] = json.loads(req.content)["gender"]
            return httpx.Response(200, json=ok({"s3_url": "https://s3.example/x.wav"}))
        return httpx.Response(200, content=wav_bytes())

    _live(monkeypatch, handler)
    await bhashini.tts("hello", "hi", voice="robot")
    assert seen["gender"] == "female"


# --- OCR --------------------------------------------------------------------------------

PNG = (bhashini.get_settings().fixtures_dir / "language-api" / "ocr.image.png").read_bytes()
JPG = b"\xff\xd8\xff\xe0" + b"\0" * 32


async def test_ocr_live_uploads_image_as_file_form_field(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["body"] = req.content
        return httpx.Response(200, json=ok({"decoded_text": "5000 mAh\n"}))

    _live(monkeypatch, handler)
    assert await bhashini.ocr("en", image_base64=b64(JPG)) == "5000 mAh"
    assert b'name="file"; filename="image.jpg"' in seen["body"]
    assert b"Content-Type: image/jpeg" in seen["body"]


@pytest.mark.parametrize(
    ("lang", "path"), [("en", "/ocr-en"), ("hi", "/ocr-hi"), ("te", "/ocr-en")]
)
async def test_ocr_picks_model_by_language_falling_back_to_english(monkeypatch, lang, path):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        return httpx.Response(200, json=ok({"decoded_text": "x"}))

    _live(monkeypatch, handler)
    await bhashini.ocr(lang, image_base64=b64(JPG))
    assert seen["path"] == path


async def test_ocr_live_downloads_image_url_without_credentials(monkeypatch):
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "img.example.com":
            seen["download_token"] = req.headers.get("access-token")
            seen["cookie"] = req.headers.get("cookie")
            return httpx.Response(200, content=PNG)
        assert b'filename="image.png"' in req.content
        return httpx.Response(200, json=ok({"decoded_text": "Zentra"}))

    _live(monkeypatch, handler)
    assert await bhashini.ocr("en", image_url="https://img.example.com/a.png") == "Zentra"
    assert seen == {"download_token": None, "cookie": None}


@pytest.mark.parametrize(
    "url",
    [
        "http://img.example.com/a.png",
        "https://localhost/a.png",
        "https://127.0.0.1/a.png",
        "https://[::1]/a.png",
        "https://metadata.internal/a.png",
        "file:///etc/passwd",
    ],
)
async def test_ocr_refuses_non_public_urls(monkeypatch, url):
    _live(monkeypatch, lambda req: pytest.fail("must not fetch"))
    with pytest.raises(ApiError) as exc:
        await bhashini.ocr("en", image_url=url)
    assert exc.value.code == ErrorCode.validation


def test_public_https_check_allows_hex_like_hostnames():
    bhashini._check_public_https("https://cafe.com/a.png")
    bhashini._check_public_https("https://m.media-amazon.com/images/I/a.jpg")


async def test_ocr_missing_image_is_not_found(monkeypatch):
    _live(monkeypatch, lambda req: httpx.Response(404))
    with pytest.raises(ApiError) as exc:
        await bhashini.ocr("en", image_url="https://img.example.com/gone.png")
    assert exc.value.code == ErrorCode.not_found


async def test_ocr_rejects_non_jpg_png_and_oversized_images():
    with pytest.raises(ApiError, match="JPG or PNG"):
        await bhashini.ocr("en", image_base64=b64(b"GIF89a....."))
    with pytest.raises(ApiError, match="5 MB"):
        await bhashini.ocr("en", image_base64=b64(PNG + b"\0" * bhashini.MAX_UPLOAD_BYTES))


async def test_ocr_needs_exactly_one_image_source():
    assert await bhashini.ocr("en", image_url="https://img.example.com/a.jpg")  # mock
    with pytest.raises(ApiError):
        await bhashini.ocr("en")
    with pytest.raises(ApiError):
        await bhashini.ocr("en", image_url="https://x.com/a", image_base64=b64(PNG))


# --- Timeouts and warm-up (from the live smoke test) -------------------------------------


@pytest.mark.parametrize(
    ("task", "key", "body", "seconds"),
    [
        ("mt", "en-hi", {"input_text": "hi"}, 20.0),
        ("tts", "hi", {"text": "hi", "gender": "female"}, 30.0),
    ],
)
async def test_read_timeout_is_per_task(monkeypatch, task, key, body, seconds):
    """First calls to a cold model took 6-10 s and TTS up to 19 s, so 10 s was too short."""
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["read"] = req.extensions["timeout"]["read"]
        return httpx.Response(200, json=ok({}))

    _live(monkeypatch, handler)
    await call_model(task, key, body)
    assert seen["read"] == seconds


async def test_warm_up_calls_each_configured_model_once_and_never_raises(monkeypatch):
    calls = []

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append(req.url.path)
        if req.url.path == "/mt":
            return httpx.Response(500)
        return httpx.Response(200, json=ok({}))

    _live(monkeypatch, handler)
    result = await bhashini.warm_up()
    assert sorted(calls) == ["/asr", "/mt", "/ocr-en", "/ocr-hi", "/tts"]  # no S3 download
    assert result == {
        "asr hi": "ok",
        "mt en-hi": "upstream_unavailable",
        "tts hi": "ok",
        "ocr en": "ok",
        "ocr hi": "ok",
    }


async def test_warm_up_skips_unconfigured_models(monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    reg = Registry.from_dict(
        {"asr": {"hi": {"url": "https://up.example/asr", "token": "T"}, "te": {}}}
    )
    monkeypatch.setattr(bhashini, "_registry", reg)
    monkeypatch.setattr(
        bhashini, "_transport", httpx.MockTransport(lambda req: httpx.Response(200, json=ok({})))
    )
    assert await bhashini.warm_up() == {"asr hi": "ok"}


async def test_warm_up_does_nothing_in_mock_mode(monkeypatch):
    monkeypatch.setattr(bhashini, "_transport", httpx.MockTransport(lambda req: pytest.fail()))
    assert await bhashini.warm_up() == {}


def test_start_warm_up_respects_the_off_switch(monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setenv("LANGUAGE_WARMUP", "0")
    assert bhashini.start_warm_up() is None


async def test_warm_up_runs_at_most_two_calls_at_once(monkeypatch):
    """Live: firing all models at once made the shared OCR service return HTTP 500."""
    active, peak = 0, 0

    async def handler(req: httpx.Request) -> httpx.Response:
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return httpx.Response(200, json=ok({}))

    _live(monkeypatch, handler)
    result = await bhashini.warm_up()
    assert len(result) == 5 and set(result.values()) == {"ok"}
    assert peak == 2


async def test_mock_mt_translates_only_its_recorded_input():
    """MOCK must never pass off a canned sentence as the translation of other text: consumers
    (Track C's /turn) then keep English and say so, exactly as in real mode on a failure."""
    assert await bhashini.translate("Battery capacity: ZQX0", "en", "hi") == "बैटरी क्षमता: ZQX0"
    with pytest.raises(ApiError) as exc:
        await bhashini.translate("isse cart mein daal do", "hi", "en")
    assert exc.value.code == ErrorCode.upstream_unavailable and not exc.value.retryable


# --- Placeholder integrity (rule 7 + rule 1) ---------------------------------------------


@pytest.mark.parametrize(
    "returned",
    ["ZQX0 की कीमत ZQX1 है", "ZQX 0 की कीमत zqx1 है", "ZQX० की कीमत ZQX१ है"],
)
async def test_translate_accepts_placeholders_the_mt_merely_reformatted(monkeypatch, returned):
    _live(monkeypatch, lambda req: httpx.Response(200, json=ok({"output_text": returned})))
    assert await bhashini.translate("ZQX0 costs ZQX1", "en", "hi") == returned


async def test_translate_fails_rather_than_drop_a_masked_name_or_price(monkeypatch):
    """A lost placeholder means a brand or price silently vanished (or, as ⟦0⟧ showed live,
    got replaced by an invented number): fail so callers keep English."""
    _live(monkeypatch, lambda req: httpx.Response(200, json=ok({"output_text": "ZQX0 की कीमत है"})))
    with pytest.raises(ApiError) as exc:
        await bhashini.translate("ZQX0 costs ZQX1", "en", "hi")
    assert exc.value.code == ErrorCode.upstream_unavailable and not exc.value.retryable
    # and the bad result was not cached
    _live(monkeypatch, lambda req: httpx.Response(200, json=ok({"output_text": "ZQX0 ZQX1"})))
    assert await bhashini.translate("ZQX0 costs ZQX1", "en", "hi") == "ZQX0 ZQX1"
