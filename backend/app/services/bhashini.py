"""Single gateway to Bhashini/AnuvaadHub models (rule 6). No other module may call them.

Registry: backend/config/models.local.json (gitignored), same shape as models.example.json:
    {"asr": {"hi": {"url", "token", "model"}}, "mt": {"en-hi": {...}}, "tts": {...},
     "ocr": {...}, "rpm": {"asr": 30, "mt": 60, "tts": 60, "ocr": 10}}
A token bucket per model enforces the approved RPM. With MOCK=1, calls are served from
fixtures/language-api/ and never touch the network.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from app.config import REPO_ROOT, get_settings
from app.errors import ApiError

Task = Literal["asr", "mt", "tts", "ocr"]
TASKS: tuple[Task, ...] = ("asr", "mt", "tts", "ocr")
EXAMPLE_FILE = REPO_ROOT / "backend/config/models.example.json"


@dataclass(frozen=True)
class ModelEntry:
    task: Task
    key: str  # language ("hi") or pair ("en-hi") or "default"
    url: str
    token: str
    model: str
    rpm: int

    @property
    def configured(self) -> bool:
        return bool(self.url and self.token)


class Registry:
    def __init__(self, entries: dict[tuple[Task, str], ModelEntry]):
        self._entries = entries

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Registry:
        rpm = data.get("rpm", {})
        entries: dict[tuple[Task, str], ModelEntry] = {}
        for task in TASKS:
            for key, cfg in (data.get(task) or {}).items():
                entries[(task, key)] = ModelEntry(
                    task=task,
                    key=key,
                    url=cfg.get("url", ""),
                    token=cfg.get("token", ""),
                    model=cfg.get("model", ""),
                    rpm=int(rpm.get(task, 30)),
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
                "model_not_configured",
                f"No {task} model for {key}.",
                status=400,
                retryable=False,
            )
        return entry

    def keys(self, task: Task) -> list[str]:
        return sorted(k for t, k in self._entries if t == task)


class TokenBucket:
    """Classic token bucket: capacity = rpm, refills at rpm/60 tokens per second."""

    def __init__(self, rpm: int, clock: Callable[[], float] = time.monotonic):
        self.capacity = float(rpm)
        self.rate = rpm / 60.0
        self.tokens = float(rpm)
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


class Limiter:
    """One bucket per model. Waits briefly for a token, otherwise raises a retryable 429."""

    def __init__(self, max_wait_s: float = 2.0, clock: Callable[[], float] = time.monotonic):
        self._buckets: dict[tuple[Task, str], TokenBucket] = {}
        self._max_wait = max_wait_s
        self._clock = clock

    def bucket(self, entry: ModelEntry) -> TokenBucket:
        k = (entry.task, entry.key)
        if k not in self._buckets:
            self._buckets[k] = TokenBucket(entry.rpm, self._clock)
        return self._buckets[k]

    async def acquire(self, entry: ModelEntry) -> None:
        bucket = self.bucket(entry)
        if bucket.try_acquire():
            return
        wait = bucket.wait_time()
        if wait > self._max_wait:
            raise ApiError(
                "rate_limited",
                "The language service is busy. Please try again in a moment.",
                status=429,
                retryable=True,
            )
        await asyncio.sleep(wait)
        if not bucket.try_acquire():
            raise ApiError(
                "rate_limited", "The language service is busy.", status=429, retryable=True
            )


_registry: Registry | None = None
_limiter = Limiter()


def registry() -> Registry:
    global _registry
    if _registry is None:
        _registry = Registry.load()
    return _registry


async def call_model(task: Task, key: str, payload: dict[str, Any]) -> dict[str, Any]:
    """Call one model. STUB for real mode: the AnuvaadHub request format comes from the
    API spec PDF (Track A); until then only MOCK=1 works."""
    entry = registry().get(task, key)
    await _limiter.acquire(entry)
    if get_settings().mock:
        return _mock_response(task, key)
    if not entry.configured:
        raise ApiError("model_not_configured", f"{task} {key} has no token yet.", status=503)
    raise ApiError("not_implemented", "Live language API calls are not wired up yet.", status=501)


def _mock_response(task: Task, key: str) -> dict[str, Any]:
    path = get_settings().fixtures_dir / "language-api" / f"{task}.{key}.json"
    if path.exists():
        return json.loads(path.read_text())
    return {"mock": True, "task": task, "key": key}
