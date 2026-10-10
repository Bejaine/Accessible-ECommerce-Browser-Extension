"""/speech/asr, /speech/tts, /translate and /ocr go through the gateway (MOCK=1 serves
fixtures/language-api/), validate against their schemas and fail as ErrorResponse."""

import base64
import io
import json
import wave

import httpx
import pytest

from app.services import bhashini, masking
from app.services.bhashini import Limiter, Registry

V = {"schema_version": "1.0"}


def wav_b64(seconds: float = 0.1, rate: int = 16000) -> str:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(seconds * rate))
    return base64.b64encode(buf.getvalue()).decode()


def fixture_text(name: str, field: str) -> str:
    path = bhashini.get_settings().fixtures_dir / "language-api" / name
    return json.loads(path.read_text())["data"][field]


@pytest.fixture(autouse=True)
def fresh_gateway(monkeypatch):
    """Never load models.local.json in tests: real tokens must not reach a test run."""
    monkeypatch.setattr(bhashini, "_registry", Registry.load(bhashini.EXAMPLE_FILE))
    monkeypatch.setattr(bhashini, "_limiter", Limiter())
    bhashini.clear_caches()


def assert_error(res, assert_schema, status: int, code: str) -> dict:
    assert res.status_code == status, res.text
    body = res.json()
    assert_schema("ErrorResponse", body)
    assert body["code"] == code
    return body


# --- /speech/asr ------------------------------------------------------------------------


@pytest.mark.parametrize("lang", ["en", "hi", "te"])
def test_asr_returns_transcript_and_our_mic_level(client, assert_schema, lang):
    req = {**V, "lang": lang, "audio_base64": wav_b64(), "encoding": "wav", "mic_level": 0.46}
    res = client.post("/speech/asr", json=req)
    assert res.status_code == 200, res.text
    body = res.json()
    assert_schema("ASRResponse", body)
    assert body["text"] == fixture_text(f"asr.{lang}.json", "recognized_text")
    assert body["lang"] == lang
    assert body["asr_meta"] == {"confidence": None, "mic_level": 0.46, "alternatives": []}


def test_asr_without_mic_level_reports_null(client, assert_schema):
    req = {**V, "lang": "hi", "audio_base64": wav_b64(), "encoding": "wav"}
    body = client.post("/speech/asr", json=req).json()
    assert_schema("ASRResponse", body)
    assert body["asr_meta"]["mic_level"] is None


def test_asr_rejects_non_wav_with_a_calm_validation_error(client, assert_schema):
    req = {**V, "lang": "hi", "audio_base64": wav_b64(), "encoding": "webm"}
    body = assert_error(client.post("/speech/asr", json=req), assert_schema, 400, "validation")
    assert "WAV" in body["error"] and not body["retryable"]


def test_asr_rejects_too_long_audio(client, assert_schema):
    req = {**V, "lang": "en", "audio_base64": wav_b64(seconds=21, rate=8000), "encoding": "wav"}
    assert_error(client.post("/speech/asr", json=req), assert_schema, 400, "validation")


def test_asr_unsupported_language_is_rejected_by_the_schema(client, assert_schema):
    req = {**V, "lang": "ta", "audio_base64": wav_b64(), "encoding": "wav"}
    assert_error(client.post("/speech/asr", json=req), assert_schema, 422, "validation")


# --- /speech/tts ------------------------------------------------------------------------


@pytest.mark.parametrize("lang", ["en", "hi", "te"])
def test_tts_returns_playable_wav(client, assert_schema, lang):
    res = client.post("/speech/tts", json={**V, "text": "Added to cart.", "lang": lang})
    assert res.status_code == 200, res.text
    body = res.json()
    assert_schema("TTSResponse", body)
    assert body["encoding"] == "wav" and body["lang"] == lang
    with wave.open(io.BytesIO(base64.b64decode(body["audio_base64"]))) as w:
        assert w.getnframes() > 0


def test_tts_second_identical_request_is_served_from_cache(client, monkeypatch):
    req = {**V, "text": "Added to cart.", "lang": "hi", "voice": "female"}
    first = client.post("/speech/tts", json=req).json()
    calls = []
    real = bhashini.call_model

    async def spy(*a, **k):
        calls.append(a)
        return await real(*a, **k)

    monkeypatch.setattr(bhashini, "call_model", spy)
    second = client.post("/speech/tts", json=req).json()
    assert first["cached"] is False and second["cached"] is True
    assert second["audio_base64"] == first["audio_base64"]
    assert calls == []


def test_tts_cache_is_per_language_and_voice(client):
    base = {**V, "text": "Added to cart.", "lang": "hi"}
    client.post("/speech/tts", json=base)
    assert client.post("/speech/tts", json={**base, "lang": "te"}).json()["cached"] is False
    assert client.post("/speech/tts", json={**base, "voice": "male"}).json()["cached"] is False


def test_tts_with_only_symbols_is_a_validation_error(client, assert_schema):
    res = client.post("/speech/tts", json={**V, "text": "*** ---", "lang": "en"})
    assert_error(res, assert_schema, 400, "validation")


# --- /translate -------------------------------------------------------------------------


def test_translate_en_to_hi(client, assert_schema):
    req = {**V, "text": "Battery capacity: 5000 mAh", "source_lang": "en", "target_lang": "hi"}
    res = client.post("/translate", json=req)
    assert res.status_code == 200, res.text
    body = res.json()
    assert_schema("TranslateResponse", body)
    assert body == {
        **V,
        "text": fixture_text("mt.en-hi.json", "output_text"),
        "source_lang": "en",
        "target_lang": "hi",
    }


def test_translate_same_language_echoes(client):
    req = {**V, "text": "hello", "source_lang": "en", "target_lang": "en"}
    assert client.post("/translate", json=req).json()["text"] == "hello"


def test_translate_hi_to_te_pivots(client):
    req = {**V, "text": "बैटरी क्षमता: 5000 mAh", "source_lang": "hi", "target_lang": "te"}
    body = client.post("/translate", json=req).json()
    assert body["text"] == fixture_text("mt.en-te.json", "output_text")


def test_translate_masks_before_mt_and_unmasks_after(client, monkeypatch):
    """Rule 7: the MT model only ever sees placeholders for brands, units and prices."""
    sent = []

    def fake_mask(text):
        return text.replace("boAt", "⟦B0⟧"), {"⟦B0⟧": "boAt"}

    async def fake_call(task, key, json_body=None, **kw):
        sent.append(json_body["input_text"])
        return {"output_text": json_body["input_text"].replace("buy", "खरीदें")}

    monkeypatch.setattr(masking, "mask", fake_mask)
    monkeypatch.setattr(bhashini, "call_model", fake_call)
    req = {**V, "text": "buy boAt", "source_lang": "en", "target_lang": "hi"}
    assert client.post("/translate", json=req).json()["text"] == "खरीदें boAt"
    assert sent == ["buy ⟦B0⟧"]


# --- /ocr -------------------------------------------------------------------------------


PNG_B64 = base64.b64encode(
    (bhashini.get_settings().fixtures_dir / "language-api" / "ocr.image.png").read_bytes()
).decode()


@pytest.mark.parametrize(
    "source",
    [{"image_url": "https://m.media-amazon.com/images/I/box.jpg"}, {"image_base64": PNG_B64}],
)
def test_ocr_reads_text(client, assert_schema, source):
    res = client.post("/ocr", json={**V, "lang": "en", **source})
    assert res.status_code == 200, res.text
    body = res.json()
    assert_schema("OCRResponse", body)
    assert body["text"] == fixture_text("ocr.en.json", "decoded_text").strip()


def test_ocr_with_both_sources_is_a_validation_error(client, assert_schema):
    req = {**V, "lang": "en", "image_url": "https://x.com/a.png", "image_base64": PNG_B64}
    assert_error(client.post("/ocr", json=req), assert_schema, 400, "validation")


def test_ocr_with_no_source_is_a_validation_error(client, assert_schema):
    assert_error(client.post("/ocr", json={**V, "lang": "en"}), assert_schema, 422, "validation")


# --- Real mode failures reach the client as ErrorResponse -------------------------------


def test_real_mode_without_tokens_is_upstream_unavailable(client, assert_schema, monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setattr(bhashini, "_registry", Registry.load(bhashini.EXAMPLE_FILE))
    req = {**V, "text": "hello", "source_lang": "en", "target_lang": "hi"}
    body = assert_error(
        client.post("/translate", json=req), assert_schema, 503, "upstream_unavailable"
    )
    assert "token" not in body["error"].lower()


def test_rate_limited_is_a_retryable_429(client, assert_schema, monkeypatch):
    reg = Registry.from_dict(
        {"tts": {"hi": {"url": "https://up.example/tts", "token": "T"}}, "rpm": {"tts": 1}}
    )
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setattr(bhashini, "_registry", reg)
    monkeypatch.setattr(bhashini, "_limiter", Limiter(max_wait_s=0))
    envelope = {
        "status": "success",
        "data": {"s3_url": "https://s3.example/a.wav"},
        "error": None,
        "code": 200,
    }

    def handler(req):
        if req.url.host == "up.example":
            return httpx.Response(200, json=envelope)
        return httpx.Response(200, content=base64.b64decode(wav_b64()))

    monkeypatch.setattr(bhashini, "_transport", httpx.MockTransport(handler))
    assert client.post("/speech/tts", json={**V, "text": "one", "lang": "hi"}).status_code == 200
    res = client.post("/speech/tts", json={**V, "text": "two", "lang": "hi"})
    assert assert_error(res, assert_schema, 429, "rate_limited")["retryable"] is True


def test_app_startup_starts_the_language_warm_up(monkeypatch):
    from fastapi.testclient import TestClient

    from app.main import app

    started = []
    monkeypatch.setattr(bhashini, "start_warm_up", lambda: started.append(1))
    with TestClient(app):
        pass
    assert started == [1]


def test_mock_translate_of_unrecorded_text_is_unavailable(client, assert_schema):
    req = {**V, "text": "something nobody recorded", "source_lang": "en", "target_lang": "hi"}
    assert_error(client.post("/translate", json=req), assert_schema, 503, "upstream_unavailable")
