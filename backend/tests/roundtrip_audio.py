"""Real-voice ASR round trip (Track A "done means"). Makes REAL AnuvaadHub calls.

Not collected by pytest (no test_ prefix); run by hand when tokens are configured:

    cd backend && MOCK=0 PYTHONPATH=../shared/generated/py \
        ../.venv/bin/python tests/roundtrip_audio.py

Sends every clip in fixtures/audio/ (16 kHz WAV of a team member reading a shopping command,
recorded with consent) through live ASR and compares the transcript with fixtures/audio/
expected.json: word error rate (WER) after folding spelling variants (nukta, chandrabindu,
ZWNJ, case, punctuation) and normalising numbers on both sides, plus, for budget clips,
whether the spoken amount comes out as the right number.
"""

from __future__ import annotations

import asyncio
import base64
import json
import re
import sys
import time
import unicodedata

from app.config import REPO_ROOT, get_settings
from app.errors import ApiError
from app.services import bhashini
from app.services.numbers import normalise_numbers

AUDIO = REPO_ROOT / "fixtures/audio"


def words(text: str, lang: str) -> list[str]:
    text = normalise_numbers(text, lang).lower()
    text = text.replace("‌", "").replace("‍", "").replace("़", "")  # ZWNJ/ZWJ, nukta
    text = unicodedata.normalize("NFD", text).replace("़", "")
    text = unicodedata.normalize("NFC", text).replace("ँ", "ं")  # chandrabindu → anusvara
    text = "".join(" " if unicodedata.category(c).startswith("P") else c for c in text)
    return re.sub(r"(?<=\d),(?=\d)", "", text).split()


def wer(reference: list[str], heard: list[str]) -> float:
    """Word error rate: word-level edit distance / reference length."""
    d = list(range(len(heard) + 1))
    for i, r in enumerate(reference, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(heard, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r != h))
    return d[-1] / max(1, len(reference))


async def run() -> list[dict]:
    expected = json.loads((AUDIO / "expected.json").read_text())
    rows = []
    for name, exp in expected.items():
        audio = base64.b64encode((AUDIO / name).read_bytes()).decode()
        start = time.perf_counter()
        try:
            heard = (await bhashini.asr(exp["lang"], audio_base64=audio, encoding="wav")).text
        except ApiError as exc:
            rows.append({"clip": name, "error": exc.code.value})
            continue
        row = {
            "clip": name,
            "lang": exp["lang"],
            "expected": exp["text"],
            "heard": heard,
            "wer": round(wer(words(exp["text"], exp["lang"]), words(heard, exp["lang"])), 2),
            "ms": round((time.perf_counter() - start) * 1000),
        }
        if "number" in exp:
            row["number_ok"] = str(exp["number"]) in words(heard, exp["lang"])
        rows.append(row)
    return rows


def main() -> int:
    if get_settings().mock:
        print("Refusing to run with MOCK=1: set MOCK=0 (needs backend/config/models.local.json).")
        return 2
    rows = asyncio.run(run())
    for r in rows:
        if "error" in r:
            print(f"ERROR {r['clip']}: {r['error']}")
            continue
        number = "" if "number_ok" not in r else f"  number {'OK' if r['number_ok'] else 'WRONG'}"
        print(f"{r['clip']:<16} WER {r['wer']:.0%}  {r['ms']:>5} ms{number}")
        print(f"   expected: {r['expected']}\n   heard   : {r['heard']}")
    ok = [r for r in rows if "error" not in r]
    for lang in ("en", "hi", "te"):
        mine = [r["wer"] for r in ok if r["lang"] == lang]
        if mine:
            print(f"{lang}: mean WER {sum(mine) / len(mine):.0%} over {len(mine)} clips")
    return 0 if len(ok) == len(rows) else 1


if __name__ == "__main__":
    sys.exit(main())
