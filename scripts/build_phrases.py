#!/usr/bin/env python3
"""Build-time UI strings and phrase audio (Track A). Makes REAL AnuvaadHub calls.

    cd backend && MOCK=0 PYTHONPATH=../shared/generated/py \
        ../.venv/bin/python ../scripts/build_phrases.py [--langs en,hi,te] [--no-audio]

1. extension/src/i18n/<lang>.json: translates every key of en.json that the file is missing
   (through the gateway, with masking). Existing entries are never overwritten, so hand
   corrections and hand-written strings (e.g. onboarding.choose_language) survive.
2. extension/src/i18n/audio/<lang>/<key>.wav: TTS for the strings listed in prerecord.json (short,
   frequent phrases and onboarding: WAV is ~32 KB/s, so long messages are spoken live instead)
   whose recording is missing or was made from different text (audio/manifest.json records the
   text), as 16 kHz mono 16-bit PCM. Recordings of strings no longer listed are deleted.
Review the new translations it prints before committing.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import os
import sys
import wave
from array import array
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "shared/generated/py")]

from app.config import get_settings  # noqa: E402
from app.errors import ApiError  # noqa: E402
from app.models import ErrorCode  # noqa: E402
from app.services import bhashini  # noqa: E402

I18N = ROOT / "extension/src/i18n"
AUDIO = I18N / "audio"
RATE = 16000
RETRY = {ErrorCode.rate_limited, ErrorCode.upstream_unavailable}


async def with_retry(make_call, what: str, attempts: int = 4):
    for attempt in range(1, attempts + 1):
        try:
            return await make_call()
        except ApiError as exc:
            if exc.code not in RETRY or attempt == attempts:
                raise
            wait = 15 * attempt
            print(f"  {what}: {exc.code.value}, retrying in {wait} s")
            await asyncio.sleep(wait)


def to_16k_mono(wav_bytes: bytes) -> bytes:
    """Box-filter resample of a 16-bit PCM WAV to 16 kHz mono (mirrors extension wav.ts)."""
    with wave.open(io.BytesIO(wav_bytes)) as r:
        channels, width, rate = r.getnchannels(), r.getsampwidth(), r.getframerate()
        if width != 2:
            raise ValueError(f"expected 16-bit PCM, got {width * 8}-bit")
        samples = array("h", r.readframes(r.getnframes()))
    if sys.byteorder == "big":
        samples.byteswap()
    if channels > 1:
        samples = array("h", (sum(samples[i : i + channels]) // channels
                              for i in range(0, len(samples), channels)))  # fmt: skip
    if rate != RATE:
        ratio = rate / RATE
        out = array("h")
        for i in range(int(len(samples) / ratio)):
            start, end = int(i * ratio), max(int(i * ratio) + 1, int((i + 1) * ratio))
            chunk = samples[start:end]
            out.append(sum(chunk) // len(chunk))
        samples = out
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes() if sys.byteorder == "little" else _swapped(samples))
    return buf.getvalue()


def _swapped(samples: array) -> bytes:
    copy = array("h", samples)
    copy.byteswap()
    return copy.tobytes()


def load(path: Path) -> dict[str, str]:
    return json.loads(path.read_text()) if path.exists() else {}


def save(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


async def build_strings(en: dict[str, str], lang: str) -> dict[str, str]:
    path = I18N / f"{lang}.json"
    table = load(path)
    for key, text in en.items():
        if key in table:
            continue
        table[key] = await with_retry(lambda t=text: bhashini.translate(t, "en", lang), key)
        print(f"  NEW {lang} {key}: {table[key]}")
    ordered = {k: table[k] for k in en if k in table}  # same order as en.json, no stray keys
    save(path, ordered)
    return ordered


async def build_audio(strings: dict[str, str], lang: str, manifest: dict) -> None:
    wanted = set(json.loads((I18N / "prerecord.json").read_text()))
    strings = {k: v for k, v in strings.items() if k in wanted}
    recorded = manifest.setdefault(lang, {})
    folder = AUDIO / lang
    folder.mkdir(parents=True, exist_ok=True)
    for key, text in strings.items():
        file = folder / f"{key}.wav"
        if file.exists() and recorded.get(key) == text:
            continue
        result = await with_retry(lambda t=text: bhashini.tts(t, lang), f"tts {lang} {key}")
        file.write_bytes(to_16k_mono(base64.b64decode(result.audio_base64)))
        recorded[key] = text
        save(AUDIO / "manifest.json", manifest)  # after each file, so a crash loses nothing
        print(f"  audio {lang} {key}: {file.stat().st_size // 1024} KB")
    for stale in set(recorded) - set(strings):  # removed from en.json or prerecord.json
        recorded.pop(stale)
        (folder / f"{stale}.wav").unlink(missing_ok=True)


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--langs", default="en,hi,te")
    parser.add_argument("--no-audio", action="store_true")
    args = parser.parse_args()
    if get_settings().mock:
        print("Refusing to run with MOCK=1: set MOCK=0 (needs backend/config/models.local.json).")
        return 2
    os.environ.setdefault("LANGUAGE_WARMUP", "0")
    en = load(I18N / "en.json")
    manifest = load(AUDIO / "manifest.json")
    for lang in args.langs.split(","):
        print(f"== {lang}")
        strings = en if lang == "en" else await build_strings(en, lang)
        if not args.no_audio:
            await build_audio(strings, lang, manifest)
    save(AUDIO / "manifest.json", manifest)
    total = sum(f.stat().st_size for f in AUDIO.glob("*/*.wav"))
    print(f"\nphrase audio: {len(list(AUDIO.glob('*/*.wav')))} files, {total / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
