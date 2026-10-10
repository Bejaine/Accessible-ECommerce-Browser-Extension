"""Single gateway to Bhashini/AnuvaadHub models (rule 6). No other module may call them.

Registry: backend/config/models.local.json (gitignored), same shape as models.example.json:
    {"asr": {"hi": {"url", "token", "model", "auth_header"?, "rpm"?}}, "mt": {"en-hi": {...}},
     "tts": {...}, "ocr": {...}, "rpm": {"asr": 30, "mt": 60, "tts": 60, "ocr": 10}}
A token bucket per model enforces the approved RPM. With MOCK=1, calls are served from
fixtures/language-api/<task>.<key>.json and never touch the network or the limiter.

Callers use the task helpers (asr, translate, tts, ocr), which return normalised results.
The AnuvaadHub wire format (ANUVAADHUB_API_SPECIFICATIONS.pdf) lives only in the "Wire
format" section below. Each model has its own endpoint, so the language or language pair is
chosen by the registry entry, never sent in the payload.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import io
import json
import logging
import os
import re
import time
import unicodedata
import wave
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

import httpx

from app.config import REPO_ROOT, get_settings
from app.errors import ApiError
from app.models import ErrorCode
from app.services import masking, numbers
from app.services.cache import TTLCache

Task = Literal["asr", "mt", "tts", "ocr"]
TASKS: tuple[Task, ...] = ("asr", "mt", "tts", "ocr")
EXAMPLE_FILE = REPO_ROOT / "backend/config/models.example.json"
WARM_UP_IMAGE = REPO_ROOT / "fixtures/language-api/smoke/ocr_en.png"
WARM_UP_CONCURRENCY = 2  # the shared sandbox returns HTTP 500 when ~20 calls arrive at once
log = logging.getLogger(__name__)
PIVOT_LANG = "en"
OCR_FALLBACK_LANG = "en"

_KEY_PATTERNS: dict[Task, re.Pattern[str]] = {
    "asr": re.compile(r"^[a-z]{2,3}$"),
    "tts": re.compile(r"^[a-z]{2,3}$"),
    "mt": re.compile(r"^[a-z]{2,3}-[a-z]{2,3}$"),
    "ocr": re.compile(r"^[a-z0-9_-]+$"),
}


@dataclass(frozen=True)
class ModelEntry:
    task: Task
    key: str  # language ("hi") or pair ("en-hi")
    url: str
    token: str = field(repr=False)
    model: str
    rpm: int
    auth_header: str = "access-token"

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)


class Registry:
    def __init__(self, entries: dict[tuple[Task, str], ModelEntry]):
        self._entries = entries

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Registry:
        """Build from the models file. Raises ValueError on a malformed file (a setup bug,
        not a user error), so it fails loudly at startup instead of mid-conversation."""
        rpm = data.get("rpm", {})
        entries: dict[tuple[Task, str], ModelEntry] = {}
        for task in TASKS:
            for key, cfg in (data.get(task) or {}).items():
                if not _KEY_PATTERNS[task].match(key):
                    raise ValueError(f"models file: bad {task} key {key!r}")
                limit = int(cfg.get("rpm", rpm.get(task, 30)))
                if limit < 1:
                    raise ValueError(f"models file: rpm for {task} {key} must be >= 1")
                entries[(task, key)] = ModelEntry(
                    task=task,
                    key=key,
                    url=cfg.get("url", ""),
                    token=cfg.get("token", ""),
                    model=cfg.get("model", ""),
                    rpm=limit,
                    auth_header=cfg.get("auth_header") or "access-token",
                )
        return cls(entries)

    @classmethod
    def load(cls, path: Path | None = None) -> Registry:
        """Load the local registry, falling back to the committed example (empty tokens)."""
        path = path or get_settings().models_file
        if not path.exists():
            path = EXAMPLE_FILE
        return cls.from_dict(json.loads(path.read_text()))

    def get(self, task: Task, key: str) -> ModelEntry:
        entry = self._entries.get((task, key))
        if entry is None:
            raise ApiError(
                ErrorCode.validation,
                f"No {task} model for {key}.",
                status=400,
                retryable=False,
            )
        return entry

    def has(self, task: Task, key: str) -> bool:
        return (task, key) in self._entries

    def keys(self, task: Task) -> list[str]:
        return sorted(k for t, k in self._entries if t == task)

    def mt_route(self, source: str, target: str) -> list[ModelEntry]:
        """MT models to chain for source → target: none, one direct pair, or a pivot via English."""
        if source == target:
            return []
        if self.has("mt", f"{source}-{target}"):
            return [self.get("mt", f"{source}-{target}")]
        first, second = f"{source}-{PIVOT_LANG}", f"{PIVOT_LANG}-{target}"
        if PIVOT_LANG not in (source, target) and self.has("mt", first) and self.has("mt", second):
            return [self.get("mt", first), self.get("mt", second)]
        raise ApiError(
            ErrorCode.validation,
            f"No translation model for {source} to {target}.",
            status=400,
            retryable=False,
        )


class TokenBucket:
    """Token bucket: capacity = rpm, refills at rpm/60 tokens per second. Tokens may go
    negative while callers hold reservations, so concurrent waiters queue fairly."""

    def __init__(
        self, rpm: int, clock: Callable[[], float] = time.monotonic, burst: int | None = None
    ):
        self.capacity = float(burst or rpm)
        self.rate = rpm / 60.0
        self.tokens = self.capacity
        self._clock = clock
        self._last = clock()

    def _refill(self) -> None:
        now = self._clock()
        self.tokens = min(self.capacity, self.tokens + (now - self._last) * self.rate)
        self._last = now

    def try_acquire(self) -> bool:
        self._refill()
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        return False

    def wait_time(self) -> float:
        self._refill()
        return 0.0 if self.tokens >= 1 else (1 - self.tokens) / self.rate

    def reserve(self, max_wait: float) -> float | None:
        """Take a token now or book one in the future. Returns the wait in seconds, or None
        (reserving nothing) if the wait would exceed max_wait."""
        wait = self.wait_time()
        if wait > max_wait:
            return None
        self.tokens -= 1
        return wait


class Limiter:
    """One bucket per model. Waits briefly for a token, otherwise raises a retryable 429.

    Buckets hold rpm/4 tokens, so any 60 s window sees at most 1.25 x the approved RPM even
    if the service counts a rolling minute (a full rpm-sized bucket would allow 2 x)."""

    def __init__(
        self,
        max_wait_s: float = 2.0,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ):
        self._buckets: dict[tuple[Task, str], TokenBucket] = {}
        self._max_wait = max_wait_s
        self._clock = clock
        self._sleep = sleep

    def bucket(self, entry: ModelEntry) -> TokenBucket:
        k = (entry.task, entry.key)
        if k not in self._buckets:
            self._buckets[k] = TokenBucket(entry.rpm, self._clock, burst=max(1, entry.rpm // 4))
        return self._buckets[k]

    async def acquire(self, entry: ModelEntry) -> None:
        wait = self.bucket(entry).reserve(self._max_wait)
        if wait is None:
            raise ApiError(
                ErrorCode.rate_limited,
                "The language service is busy. Please try again in a moment.",
                status=429,
                retryable=True,
            )
        if wait > 0:
            await self._sleep(wait)


def map_upstream_status(status: int) -> ApiError:
    """Turn an upstream HTTP error into our calm ErrorResponse vocabulary."""
    if status in (401, 403):
        return ApiError(
            ErrorCode.auth_expired,
            "The language service needs to be reconnected. You can type instead for now.",
            status=503,
            retryable=False,
        )
    if status == 429:
        return ApiError(
            ErrorCode.rate_limited,
            "The language service is busy. Please try again in a moment.",
            status=429,
            retryable=True,
        )
    if status == 408 or status >= 500:
        return _unavailable()
    return ApiError(
        ErrorCode.internal,
        "Something went wrong with the language service.",
        status=502,
        retryable=False,
    )


def _unavailable() -> ApiError:
    return ApiError(
        ErrorCode.upstream_unavailable,
        "The language service is not responding. Please try again.",
        status=503,
        retryable=True,
    )


_registry: Registry | None = None
_limiter = Limiter()
_transport: httpx.AsyncBaseTransport | None = None  # tests inject httpx.MockTransport
# Measured live (2026-10-11): a cold model's first call takes 6-10 s, TTS 3-19 s.
_TIMEOUTS: dict[Task, httpx.Timeout] = {
    "mt": httpx.Timeout(20.0, connect=5.0),
    "asr": httpx.Timeout(20.0, connect=5.0),
    "ocr": httpx.Timeout(20.0, connect=5.0),
    "tts": httpx.Timeout(30.0, connect=5.0),
}
_DOWNLOAD_TIMEOUT = httpx.Timeout(20.0, connect=5.0)


def registry() -> Registry:
    global _registry
    if _registry is None:
        _registry = Registry.load()
    return _registry


async def call_model(
    task: Task,
    key: str,
    json_body: dict[str, Any] | None = None,
    *,
    files: dict[str, tuple[str, bytes, str]] | None = None,
) -> dict[str, Any]:
    """POST a JSON body or multipart files to one model and return the envelope's `data`
    object, or raise an ApiError."""
    entry = registry().get(task, key)
    if get_settings().mock:
        return _unwrap(_mock_response(task, key, json_body))
    if not entry.configured:
        raise ApiError(
            ErrorCode.upstream_unavailable,
            "This language is not available yet.",
            status=503,
            retryable=False,
        )
    await _limiter.acquire(entry)
    try:
        async with httpx.AsyncClient(transport=_transport, timeout=_TIMEOUTS[task]) as client:
            res = await client.post(
                entry.url, json=json_body, files=files, headers={entry.auth_header: entry.token}
            )
    except httpx.HTTPError:
        raise _unavailable() from None  # don't chain: the request repr carries headers
    if res.status_code >= 400:
        raise map_upstream_status(res.status_code)
    try:
        envelope = res.json()
    except ValueError:
        raise _unavailable() from None
    return _unwrap(envelope)


def _unwrap(envelope: Any) -> dict[str, Any]:
    """{status, message, data, error, code}: return `data`, or map a failure (which the
    service may report with HTTP 200) through its `code`."""
    if not isinstance(envelope, dict):
        raise _unavailable()
    if envelope.get("status") != "success" or envelope.get("error"):
        code = envelope.get("code")
        if isinstance(code, int) and code >= 400:
            raise map_upstream_status(code)
        raise _unavailable()
    data = envelope.get("data")
    if not isinstance(data, dict):
        raise _unavailable()
    return data


async def _download(url: str, *, max_bytes: int, mock_file: str) -> bytes:
    """GET a public file (TTS audio on S3, a product image) with no cookies or credentials."""
    if get_settings().mock:
        return (get_settings().fixtures_dir / "language-api" / mock_file).read_bytes()
    _check_public_https(url)
    try:
        async with httpx.AsyncClient(
            transport=_transport, timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True
        ) as client:
            async with client.stream("GET", url) as res:
                if res.status_code == 404:
                    raise ApiError(ErrorCode.not_found, "That file could not be found.", status=404)
                if res.status_code >= 400:
                    raise _unavailable()
                body = bytearray()
                async for chunk in res.aiter_bytes():
                    body += chunk
                    if len(body) > max_bytes:
                        raise _too_large()
    except httpx.HTTPError:
        raise _unavailable() from None
    return bytes(body)


def _check_public_https(url: str) -> None:
    """Refuse non-https and obviously internal hosts, so the backend can't be pointed at itself."""
    try:
        parsed = httpx.URL(url)
    except (httpx.InvalidURL, TypeError):
        parsed = None
    host = (parsed.host if parsed else "").lower()
    internal = (
        host in ("", "localhost")
        or host.endswith((".local", ".internal", ".localhost"))
        or re.fullmatch(r"[\d.]+|\[?[0-9a-f]*:[0-9a-f:]*\]?", host) is not None  # literal IPs
    )
    if parsed is None or parsed.scheme != "https" or internal:
        raise _invalid("Only public https links can be read.")


def _mock_response(task: Task, key: str, json_body: dict[str, Any] | None) -> dict[str, Any]:
    path = get_settings().fixtures_dir / "language-api" / f"{task}.{key}.json"
    if not path.exists():
        raise ApiError(
            ErrorCode.internal, f"No mock response for {task} {key}.", status=500, retryable=False
        )
    envelope = json.loads(path.read_text())
    # An MT fixture translates only its recorded input: a canned sentence returned for any
    # other text would pass off unrelated words as a translation. Unrecorded text behaves like
    # an unavailable model, so callers keep English, as they would in real mode.
    recorded = envelope.pop("_mock_input", None)
    if recorded is not None and (json_body or {}).get("input_text") != recorded:
        raise ApiError(
            ErrorCode.upstream_unavailable,
            "No mock translation is recorded for this text.",
            status=503,
            retryable=False,
        )
    return envelope


# --- Task helpers (what routes and other services call) ---------------------------------


@dataclass(frozen=True)
class AsrResult:
    text: str
    confidence: float | None
    alternatives: list[str]


@dataclass(frozen=True)
class TtsResult:
    audio_base64: str
    encoding: str  # wav | mp3 | ogg
    cached: bool = False


# Successful results only, so repeated phrases and re-opened sections cost no RPM. Keyed by
# what the model actually receives (after chunking and cleaning).
_mt_cache = TTLCache(ttl_seconds=24 * 3600, max_entries=2048)
_tts_cache = TTLCache(ttl_seconds=24 * 3600, max_entries=512)


def clear_caches() -> None:
    _mt_cache.clear()
    _tts_cache.clear()


# --- Warm-up --------------------------------------------------------------------------------
# A model's first call after idling is slow (it loads), so the demo server pings every
# configured model once at startup, in the background. Off with LANGUAGE_WARMUP=0.


def start_warm_up() -> asyncio.Task[dict[str, str]] | None:
    if get_settings().mock or os.getenv("LANGUAGE_WARMUP", "1").strip() in ("0", "false", "no"):
        return None
    return asyncio.create_task(warm_up())


async def warm_up() -> dict[str, str]:
    """One tiny call per configured model; returns {"task key": "ok" | error code}. Never
    raises, and skips the TTS audio download (the call alone loads the model)."""
    if get_settings().mock:
        return {}
    reg = registry()
    jobs = [(t, k) for t in TASKS for k in reg.keys(t) if reg.get(t, k).configured]
    gate = asyncio.Semaphore(WARM_UP_CONCURRENCY)

    async def gated(task: Task, key: str) -> str:
        async with gate:
            return await _warm_one(task, key)

    outcomes = await asyncio.gather(*(gated(t, k) for t, k in jobs))
    result = {f"{t} {k}": outcome for (t, k), outcome in zip(jobs, outcomes, strict=True)}
    log.info("language model warm-up: %s", result)
    return result


async def _warm_one(task: Task, key: str) -> str:
    try:
        if task == "mt":
            await call_model(task, key, {"input_text": "hello"})
        elif task == "tts":
            await call_model(task, key, {"text": "hello", "gender": "female"})
        elif task == "asr":
            files = {"audio_file": ("audio.wav", _silent_wav(), "audio/wav")}
            await call_model(task, key, files=files)
        else:  # a blank image makes the OCR service crash (HTTP 500), so send real text
            image = WARM_UP_IMAGE.read_bytes()
            await call_model(task, key, files={"file": ("image.png", image, "image/png")})
        return "ok"
    except ApiError as exc:
        return exc.code.value
    except Exception as exc:  # a warm-up must never take the server down
        return type(exc).__name__


def _silent_wav(seconds: float = 0.5, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(seconds * rate))
    return buf.getvalue()


async def asr(lang: str, *, audio_base64: str, encoding: str) -> AsrResult:
    """The service takes WAV only, at most ~20 s and under 5 MB. It returns no confidence or
    alternatives, so those stay empty; the turn's mic level is added by the route."""
    if encoding != "wav":
        raise _invalid("Audio must be sent as WAV.")
    audio = _b64decode(audio_base64)
    if len(audio) >= MAX_UPLOAD_BYTES:
        raise _too_large()
    if _wav_seconds(audio) > ASR_MAX_SECONDS:
        raise _invalid(f"Please keep each request under {ASR_MAX_SECONDS} seconds.")
    data = await call_model("asr", lang, files={"audio_file": ("audio.wav", audio, "audio/wav")})
    return AsrResult(text=_field(data, "recognized_text").strip(), confidence=None, alternatives=[])


async def translate(text: str, source: str, target: str) -> str:
    """Translate, chaining through English when there is no direct pair, in chunks of at most
    MT_MAX_WORDS words. Callers mask brands, units and prices first (masking.py, rule 7)."""
    for entry in registry().mt_route(source, target):
        if not text.strip():
            break
        parts = []
        for chunk in chunk_words(text, MT_MAX_WORDS):
            cache_key = f"{entry.key}\n{chunk}"
            out = _mt_cache.get(cache_key)
            if out is None:
                data = await call_model("mt", entry.key, {"input_text": chunk})
                out = _field(data, "output_text").strip()
                if masking.missing(out, dict.fromkeys(masking.placeholders(chunk))):
                    raise ApiError(
                        ErrorCode.upstream_unavailable,
                        "This couldn't be translated without losing a name or price.",
                        status=503,
                        retryable=False,
                    )
                _mt_cache.set(cache_key, out)
            parts.append(out)
        text = " ".join(parts)
    return text


async def tts(text: str, lang: str, voice: str | None = None) -> TtsResult:
    """Speak text in chunks of at most TTS_MAX_WORDS words, without characters the service
    rejects. Numbers and prices are first written out in `lang` (the voices read digits in
    English and ₹ is rejected). The service returns an S3 link per chunk; we join the WAVs."""
    clean = tts_clean_text(numbers.speakable(text, lang))
    if not clean:
        raise _invalid("There is nothing to read aloud.")
    gender = voice if voice in ("male", "female") else "female"
    cache_key = f"{lang}\n{gender}\n{clean}"
    hit = _tts_cache.get(cache_key)
    if hit is not None:
        return replace(hit, cached=True)
    wavs = []
    for chunk in chunk_words(clean, TTS_MAX_WORDS):
        data = await call_model("tts", lang, {"text": chunk, "gender": gender})
        wavs.append(
            await _download(
                _field(data, "s3_url"), max_bytes=MAX_DOWNLOAD_BYTES, mock_file="tts.audio.wav"
            )
        )
    audio = join_wavs(wavs)
    result = TtsResult(audio_base64=base64.b64encode(audio).decode("ascii"), encoding="wav")
    _tts_cache.set(cache_key, result)
    return result


async def ocr(lang: str, *, image_url: str | None = None, image_base64: str | None = None) -> str:
    """Read text from a JPG/PNG under 5 MB with the OCR model for `lang` (the script expected
    in the image), falling back to English, since product images are mostly English."""
    if (image_url is None) == (image_base64 is None):
        raise _invalid("Send exactly one of image_url or image_base64.")
    if image_url is not None:
        image = await _download(image_url, max_bytes=MAX_UPLOAD_BYTES, mock_file="ocr.image.png")
    else:
        image = _b64decode(image_base64 or "")
    if len(image) >= MAX_UPLOAD_BYTES:
        raise _too_large()
    kind = _image_kind(image)
    if kind is None:
        raise _invalid("The image must be a JPG or PNG.")
    ext, mime = kind
    key = lang if registry().has("ocr", lang) else OCR_FALLBACK_LANG
    data = await call_model("ocr", key, files={"file": (f"image.{ext}", image, mime)})
    return _field(data, "decoded_text").strip()


# --- Wire format (ANUVAADHUB_API_SPECIFICATIONS.pdf) -------------------------------------
# Header `access-token`. Envelope {status, message, data, error, code}.
#   MT   JSON {"input_text"}              -> data.output_text      max 50 words
#   ASR  form audio_file (WAV)            -> data.recognized_text  ~20 s, < 5 MB
#   TTS  JSON {"text", "gender"}          -> data.s3_url (WAV)     max 30 words, no special chars
#   OCR  form file (JPG/PNG)              -> data.decoded_text     < 5 MB, white background

MT_MAX_WORDS = 50
TTS_MAX_WORDS = 30
ASR_MAX_SECONDS = 20
MAX_UPLOAD_BYTES = 5 * 1024 * 1024
MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
_TTS_PUNCTUATION = set(".,?!।")
_SENTENCE_END = re.compile(r"(?<=[.!?।॥])\s+")


def _field(data: dict[str, Any], name: str) -> str:
    value = data.get(name)
    if not isinstance(value, str):
        raise _unavailable()
    return value


def chunk_words(text: str, limit: int) -> list[str]:
    """Pack whole sentences into chunks of at most `limit` words; a longer sentence is cut at
    word boundaries."""
    chunks: list[str] = []
    current: list[str] = []
    for sentence in _SENTENCE_END.split(text.strip()):
        words = sentence.split()
        if len(current) + len(words) > limit and current:
            chunks.append(" ".join(current))
            current = []
        while len(words) > limit:
            chunks.append(" ".join(words[:limit]))
            words = words[limit:]
        current += words
    if current:
        chunks.append(" ".join(current))
    return chunks


def tts_clean_text(text: str) -> str:
    """Keep letters (any script, with their combining marks), digits and . , ? ! । — the
    service rejects special characters. Apostrophes are dropped, anything else becomes a space."""
    out = []
    for ch in text:
        if unicodedata.category(ch)[0] in "LMN" or ch in _TTS_PUNCTUATION:
            out.append(ch)
        elif ch in "'’":
            continue
        else:
            out.append(" ")
    return re.sub(r"\s+", " ", "".join(out)).strip()


def join_wavs(parts: list[bytes]) -> bytes:
    if len(parts) == 1:
        return parts[0]
    out = io.BytesIO()
    try:
        with wave.open(out, "wb") as writer:
            first = None
            for part in parts:
                with wave.open(io.BytesIO(part), "rb") as reader:
                    fmt = reader.getparams()[:3]  # channels, sample width, rate
                    if first is None:
                        first = fmt
                        writer.setparams(reader.getparams())
                    elif fmt != first:
                        raise _unavailable()
                    writer.writeframes(reader.readframes(reader.getnframes()))
    except (wave.Error, EOFError):
        raise _unavailable() from None
    return out.getvalue()


def _wav_seconds(audio: bytes) -> float:
    try:
        with wave.open(io.BytesIO(audio), "rb") as reader:
            return reader.getnframes() / reader.getframerate()
    except (wave.Error, EOFError, ZeroDivisionError):
        raise _invalid("The audio is not a readable WAV file.") from None


def _image_kind(image: bytes) -> tuple[str, str] | None:
    if image.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png", "image/png"
    if image.startswith(b"\xff\xd8\xff"):
        return "jpg", "image/jpeg"
    return None


def _b64decode(value: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise _invalid("The file data is not valid base64.") from None


def _invalid(message: str) -> ApiError:
    return ApiError(ErrorCode.validation, message, status=400, retryable=False)


def _too_large() -> ApiError:
    return _invalid("The file is too large. Please keep it under 5 MB.")
