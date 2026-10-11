"""LLM access for the brain (Track C): Groq's OpenAI-compatible chat API.

- Real mode: POST https://api.groq.com/openai/v1/chat/completions with GROQ_API_KEY.
- MOCK=1: replay recorded responses from fixtures/llm/<key>.json; no network.
- LLM_RECORD=1 (real mode): also save each raw response to fixtures/llm/<key>.json, so tests
  replay what the model really returned.

Callers pass an ordered list of models; on a rate limit the next one is tried. Any failure
raises LLMError, and callers fall back to deterministic output (never to a guess).

Several keys (GROQ_API_KEY, then GROQ_API_KEYS, comma-separated) are switched lazily: each call
uses the first key that is not cooling down, so one key is used until Groq rate-limits it. A
429 parks that (key, model) for as long as Groq says ("try again in 18m40s", else retry-after,
else 60 s); a rejected key (401/403) is parked for a day. For each model, in the callers'
order, every key is tried before moving to the next model. Keys are never logged: "#2 (…ab12)".
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


@dataclass(frozen=True)
class LLMSettings:
    api_key: str  # the key one request uses (the first key, until chat() picks another)
    model: str
    fast_model: str
    timeout_s: float
    record: bool
    api_keys: tuple[str, ...] = ()  # every configured key, in order

    @classmethod
    def load(cls) -> LLMSettings:
        keys = _keys_from_env()
        return cls(
            api_key=keys[0] if keys else "",
            api_keys=keys,
            model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
            fast_model=os.getenv("GROQ_FAST_MODEL", "openai/gpt-oss-20b"),
            timeout_s=float(os.getenv("LLM_TIMEOUT_S", "20")),
            record=os.getenv("LLM_RECORD", "0") == "1",
        )


class LLMError(Exception):
    """The LLM could not give a usable answer (not configured, rate limited, timeout, bad JSON)."""


class RateLimited(LLMError):
    """HTTP 429. `retry_after`: seconds until this key may use this model again."""

    def __init__(self, message: str = "groq rate limit", retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class KeyRejected(LLMError):
    """HTTP 401/403: the key is invalid, revoked or not allowed."""


DEFAULT_COOLDOWN_S = 60.0
REJECTED_KEY_COOLDOWN_S = 24 * 3600.0
_clock = time.monotonic
_transport: httpx.AsyncBaseTransport | None = None  # tests inject httpx.MockTransport
_cooldown: dict[tuple[str, str], float] = {}  # (key, model or "*") -> usable again at _clock()
_DURATION = re.compile(r"try again in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)", re.IGNORECASE)


def reset_key_cooldowns() -> None:
    _cooldown.clear()


def _keys_from_env() -> tuple[str, ...]:
    raw = [os.getenv("GROQ_API_KEY", ""), *re.split(r"[\s,]+", os.getenv("GROQ_API_KEYS", ""))]
    return tuple(dict.fromkeys(k.strip() for k in raw if k.strip()))


def _label(keys: tuple[str, ...], key: str) -> str:
    return f"#{keys.index(key) + 1} (…{key[-4:]})"


def _cooling(key: str, model: str) -> float:
    """Seconds until (key, model) may be used again; 0 if it can be used now."""
    until = max(_cooldown.get((key, model), 0.0), _cooldown.get((key, "*"), 0.0))
    return max(0.0, until - _clock())


def fixture_path(key: str) -> Path:
    return get_settings().fixtures_dir / "llm" / f"{key}.json"


async def chat(key: str, models: list[str], body: dict[str, Any]) -> dict[str, Any]:
    """One chat completion. `key` names the recording (e.g. "summary/specs.<product>")."""
    if get_settings().mock:
        path = fixture_path(key)
        if not path.exists():
            raise LLMError(f"no recorded LLM response for {key}")
        return json.loads(path.read_text())["response"]

    cfg = LLMSettings.load()
    if not cfg.api_keys:
        raise LLMError("GROQ_API_KEY is not set")
    last: LLMError | None = None
    for model in models:
        for api_key in cfg.api_keys:
            if _cooling(api_key, model):
                continue
            name = _label(cfg.api_keys, api_key)
            try:
                raw = await _post({**body, "model": model}, replace(cfg, api_key=api_key))
            except RateLimited as exc:
                wait = exc.retry_after if exc.retry_after is not None else DEFAULT_COOLDOWN_S
                _cooldown[(api_key, model)] = _clock() + wait
                log.warning("groq key %s %s rate limited for %.0fs: %s", name, model, wait, exc)
                last = exc
                continue
            except KeyRejected as exc:
                _cooldown[(api_key, "*")] = _clock() + REJECTED_KEY_COOLDOWN_S
                log.warning("groq key %s rejected, skipped for a day: %s", name, exc)
                last = exc
                continue
            if cfg.record:
                _record(key, model, raw)
            return raw
    if last is None and models:
        soonest = min(_cooling(k, m) for m in models for k in cfg.api_keys)
        raise RateLimited(f"all Groq keys are rate limited (next in {soonest:.0f}s)", soonest)
    raise last or LLMError("no model given")


async def _post(body: dict[str, Any], cfg: LLMSettings) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {cfg.api_key}"}
    try:
        async with httpx.AsyncClient(timeout=cfg.timeout_s, transport=_transport) as client:
            res = await client.post(GROQ_URL, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise LLMError(f"groq request failed: {type(exc).__name__}") from None  # no headers/key
    if res.status_code == 429:
        message = _groq_message(res)
        raise RateLimited(f"groq 429: {message}", _retry_after(message, res))
    if res.status_code in (401, 403):
        raise KeyRejected(f"groq {res.status_code}: {_groq_message(res)}")
    if res.status_code >= 400:
        raise LLMError(f"groq {res.status_code}: {res.text[:300]}")
    return res.json()


def _groq_message(res: httpx.Response) -> str:
    try:
        return str(res.json()["error"]["message"])[:300]
    except (ValueError, KeyError, TypeError):
        return res.text[:300]


def _retry_after(message: str, res: httpx.Response) -> float:
    """Groq says how long ("Please try again in 18m40.176s"); else retry-after; else 60 s."""
    m = _DURATION.search(message)
    if m:
        units = {"h": 3600.0, "m": 60.0, "s": 1.0, "ms": 0.001}
        parts = re.findall(r"(\d+(?:\.\d+)?)(ms|h|m|s)", m.group(1))
        return sum(float(n) * units[u] for n, u in parts)
    try:
        return float(res.headers["retry-after"])
    except (KeyError, ValueError):
        return DEFAULT_COOLDOWN_S


def _record(key: str, model: str, raw: dict[str, Any]) -> None:
    path = fixture_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"model": model, "response": raw}, indent=2, ensure_ascii=False) + "\n"
    )


async def complete_json(
    key: str,
    models: list[str],
    messages: list[dict[str, str]],
    schema: dict[str, Any],
    *,
    name: str,
    max_tokens: int = 2048,
) -> dict[str, Any]:
    """Structured output (strict JSON Schema). Returns the parsed object."""
    body = {
        "messages": messages,
        "temperature": 0,
        "max_completion_tokens": max_tokens,
        "reasoning_effort": "low",
        "include_reasoning": False,
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": name, "strict": True, "schema": schema},
        },
    }
    raw = await chat(key, models, body)
    try:
        content = raw["choices"][0]["message"]["content"]
        return json.loads(content)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise LLMError(f"unusable LLM response for {key}") from exc


async def complete_tool_call(
    key: str,
    models: list[str],
    messages: list[dict[str, str]],
    tools: list[dict[str, Any]],
    *,
    max_tokens: int = 1024,
) -> tuple[str, dict[str, Any]]:
    """Function calling: the model must call exactly one of `tools`. Returns (name, arguments)."""
    body = {
        "messages": messages,
        "tools": tools,
        "tool_choice": "required",
        "temperature": 0,
        "max_completion_tokens": max_tokens,
        "reasoning_effort": "low",
        "include_reasoning": False,
    }
    raw = await chat(key, models, body)
    try:
        call = raw["choices"][0]["message"]["tool_calls"][0]["function"]
        return call["name"], json.loads(call["arguments"] or "{}")
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise LLMError(f"no usable tool call for {key}") from exc
