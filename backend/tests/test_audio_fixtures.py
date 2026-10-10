"""Real-voice clips in fixtures/audio/ (see tests/roundtrip_audio.py for the live ASR run)."""

import base64
import json
import wave

import pytest

from app.config import REPO_ROOT
from app.services import bhashini
from app.services.bhashini import Limiter, Registry

AUDIO = REPO_ROOT / "fixtures/audio"
EXPECTED = json.loads((AUDIO / "expected.json").read_text())


@pytest.fixture(autouse=True)
def _isolated_gateway(monkeypatch):
    monkeypatch.setattr(bhashini, "_registry", Registry.load(bhashini.EXAMPLE_FILE))
    monkeypatch.setattr(bhashini, "_limiter", Limiter())


def test_every_clip_has_an_expected_sentence_and_vice_versa():
    assert sorted(EXPECTED) == sorted(p.name for p in AUDIO.glob("*.wav"))


def test_all_three_languages_have_clips():
    langs = [e["lang"] for e in EXPECTED.values()]
    assert {lang: langs.count(lang) >= 3 for lang in ("en", "hi", "te")} == dict.fromkeys(
        ("en", "hi", "te"), True
    )


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_clip_is_what_the_extension_sends(name):
    with wave.open(str(AUDIO / name)) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        assert 0.5 < w.getnframes() / w.getframerate() <= bhashini.ASR_MAX_SECONDS


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_asr_route_accepts_the_clip(client, assert_schema, name):
    req = {
        "schema_version": "1.0",
        "lang": EXPECTED[name]["lang"],
        "audio_base64": base64.b64encode((AUDIO / name).read_bytes()).decode(),
        "encoding": "wav",
        "sample_rate": 16000,
    }
    res = client.post("/speech/asr", json=req)
    assert res.status_code == 200, res.text
    assert_schema("ASRResponse", res.json())
