"""Live smoke test of the AnuvaadHub models through our gateway. Makes REAL calls.

Not collected by pytest (no test_ prefix); run by hand when tokens are configured:

    cd backend && MOCK=0 PYTHONPATH=../shared/generated/py \
        ../.venv/bin/python tests/smoke_language_api.py --out /tmp/smoke

Per language: MT en→L, TTS L, ASR L on that TTS audio, MT L→en on the transcript, and OCR L
on fixtures/language-api/smoke/ocr_L.png. ~13 calls in total, well under 50 RPM. Every raw
request/response is recorded (token never printed) to <out>/report.json; TTS audio goes to
<out>/tts_<lang>.wav so you can listen to it.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import difflib
import io
import json
import re
import sys
import time
import wave
from pathlib import Path
from typing import Any

import httpx

from app.config import REPO_ROOT, get_settings
from app.errors import ApiError
from app.services import bhashini

SOURCE = "Please add this phone to my cart"
OCR_EXPECTED = {
    "en": "Battery 5000 mAh In the box: phone, charger",
    "hi": "बैटरी 5000 mAh डिब्बे में: फ़ोन, चार्जर",
    "te": "బ్యాటరీ 5000 mAh పెట్టెలో: ఫోన్, ఛార్జర్",
    "ml": "ബാറ്ററി 5000 mAh പെട്ടിയിൽ: ഫോൺ, ചാർജർ",
}
SMOKE_DIR = REPO_ROOT / "fixtures/language-api/smoke"


class RecordingTransport(httpx.AsyncBaseTransport):
    """Passes requests through and records a redacted summary of each exchange."""

    def __init__(self) -> None:
        self._inner = httpx.AsyncHTTPTransport()
        self.log: list[dict[str, Any]] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = await request.aread()
        start = time.perf_counter()
        try:
            response = await self._inner.handle_async_request(request)
            content = await response.aread()
        except httpx.HTTPError as exc:
            self.log.append({"request": _req(request, body), "transport_error": type(exc).__name__})
            raise
        self.log.append(
            {
                "request": _req(request, body),
                "status": response.status_code,
                "content_type": response.headers.get("content-type"),
                "ms": round((time.perf_counter() - start) * 1000),
                "body": _body(response.headers.get("content-type", ""), content),
            }
        )
        return response

    async def aclose(self) -> None:
        await self._inner.aclose()


_FORM_PART = rb'name="([^"]+)"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)'


def _req(request: httpx.Request, body: bytes) -> dict[str, Any]:
    ctype = request.headers.get("content-type", "")
    out: dict[str, Any] = {
        "method": request.method,
        "url": str(request.url),
        "sent_access_token": "access-token" in request.headers,  # value never recorded
    }
    if ctype.startswith("application/json"):
        out["json"] = json.loads(body)
    elif ctype.startswith("multipart/form-data"):
        parts = re.findall(_FORM_PART, body)
        out["multipart"] = [[p.decode() for p in part] for part in parts]
        out["bytes"] = len(body)
    return out


def _body(ctype: str, content: bytes) -> Any:
    if "json" in ctype:
        try:
            return json.loads(content)
        except ValueError:
            pass
    if content[:4] == b"RIFF":
        return {"binary": "wav", "bytes": len(content)}
    text = content[:300].decode("utf-8", "replace")
    return {"bytes": len(content), "start": text}


def similarity(a: str, b: str) -> float:
    norm = lambda s: " ".join(re.sub(r"[^\w\s]", " ", s.lower()).split())  # noqa: E731
    return round(difflib.SequenceMatcher(None, norm(a), norm(b)).ratio(), 2)


def wav_info(data: bytes) -> dict[str, Any]:
    try:
        with wave.open(io.BytesIO(data)) as w:
            return {
                "channels": w.getnchannels(),
                "sample_rate": w.getframerate(),
                "sample_width_bits": w.getsampwidth() * 8,
                "seconds": round(w.getnframes() / w.getframerate(), 2),
            }
    except (wave.Error, EOFError) as exc:
        return {"unreadable_by_python_wave": str(exc), "first_bytes": data[:16].hex()}


async def step(results: list, lang: str, name: str, coro) -> Any:
    start = time.perf_counter()
    try:
        value = await coro
        results.append({"lang": lang, "step": name, "ok": True, "ms": _ms(start)})
        return value
    except ApiError as exc:
        results.append(
            {
                "lang": lang,
                "step": name,
                "ok": False,
                "ms": _ms(start),
                "error": {"code": exc.code.value, "status": exc.status, "message": exc.message},
            }
        )
        return None


def _ms(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)


async def run(langs: list[str], out: Path) -> dict[str, Any]:
    out.mkdir(parents=True, exist_ok=True)
    recorder = RecordingTransport()
    bhashini._transport = recorder
    results: list[dict[str, Any]] = []
    for lang in langs:
        r = results
        text = SOURCE
        if lang != "en":
            text = await step(r, lang, "mt en→" + lang, bhashini.translate(SOURCE, "en", lang))
            r[-1]["io"] = {"in": SOURCE, "out": text}
        if text:
            audio = await step(r, lang, "tts", bhashini.tts(text, lang))
            if audio:
                wav = base64.b64decode(audio.audio_base64)
                (out / f"tts_{lang}.wav").write_bytes(wav)
                r[-1]["io"] = {"in": text, "wav": wav_info(wav)}
                heard = await step(
                    r,
                    lang,
                    "asr (on the tts audio)",
                    bhashini.asr(lang, audio_base64=audio.audio_base64, encoding="wav"),
                )
                if heard:
                    r[-1]["io"] = {"expected": text, "heard": heard.text}
                    r[-1]["similarity"] = similarity(text, heard.text)
                    if lang != "en" and heard.text:
                        back = await step(
                            r, lang, f"mt {lang}→en", bhashini.translate(heard.text, lang, "en")
                        )
                        r[-1]["io"] = {"in": heard.text, "out": back}
        image = (SMOKE_DIR / f"ocr_{lang}.png").read_bytes()
        read = await step(
            r, lang, "ocr", bhashini.ocr(lang, image_base64=base64.b64encode(image).decode())
        )
        if read is not None:
            r[-1]["io"] = {"expected": OCR_EXPECTED[lang], "read": read}
            r[-1]["similarity"] = similarity(OCR_EXPECTED[lang], read)
    await recorder.aclose()
    report = {"results": results, "http": recorder.log}
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--langs", default="en,hi,te")
    args = parser.parse_args()
    if get_settings().mock:
        print("Refusing to run with MOCK=1: set MOCK=0 for live calls.")
        return 2
    report = asyncio.run(run(args.langs.split(","), args.out))
    for row in report["results"]:
        mark = "PASS" if row["ok"] else "FAIL"
        extra = f" sim={row['similarity']}" if "similarity" in row else ""
        print(f"{mark} {row['lang']:<3} {row['step']:<24} {row['ms']:>6} ms{extra}")
        if "io" in row:
            print("     ", json.dumps(row["io"], ensure_ascii=False))
        if "error" in row:
            print("     ", json.dumps(row["error"], ensure_ascii=False))
    print(f"\n{len(report['http'])} HTTP exchanges recorded in {args.out / 'report.json'}")
    return 0 if all(r["ok"] for r in report["results"]) else 1


if __name__ == "__main__":
    sys.exit(main())
