"""LLM access for the brain (Track C): Groq's OpenAI-compatible chat API.

- Real mode: POST https://api.groq.com/openai/v1/chat/completions with GROQ_API_KEY.
- MOCK=1: replay recorded responses from fixtures/llm/<key>.json; no network.
- LLM_RECORD=1 (real mode): also save each raw response to fixtures/llm/<key>.json, so tests
  replay what the model really returned.

Callers pass an ordered list of models; on a rate limit the next one is tried. Any failure
raises LLMError, and callers fall back to deterministic output (never to a guess).
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

log = logging.getLogger(__name__)

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


@dataclass(frozen=True)
class LLMSettings:
    api_key: str
    model: str
    fast_model: str
    timeout_s: float
    record: bool

    @classmethod
    def load(cls) -> LLMSettings:
        return cls(
            api_key=os.getenv("GROQ_API_KEY", ""),
            model=os.getenv("GROQ_MODEL", "openai/gpt-oss-120b"),
            fast_model=os.getenv("GROQ_FAST_MODEL", "openai/gpt-oss-20b"),
            timeout_s=float(os.getenv("LLM_TIMEOUT_S", "20")),
            record=os.getenv("LLM_RECORD", "0") == "1",
        )


class LLMError(Exception):
    """The LLM could not give a usable answer (not configured, rate limited, timeout, bad JSON)."""


class RateLimited(LLMError):
    pass


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
    if not cfg.api_key:
        raise LLMError("GROQ_API_KEY is not set")
    last: LLMError = LLMError("no model given")
    for model in models:
        try:
            raw = await _post({**body, "model": model}, cfg)
        except RateLimited as exc:
            log.warning("groq %s rate limited, trying next model", model)
            last = exc
            continue
        if cfg.record:
            _record(key, model, raw)
        return raw
    raise last


async def _post(body: dict[str, Any], cfg: LLMSettings) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {cfg.api_key}"}
    try:
        async with httpx.AsyncClient(timeout=cfg.timeout_s) as client:
            res = await client.post(GROQ_URL, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise LLMError(f"groq request failed: {exc!r}") from exc
    if res.status_code == 429:
        raise RateLimited("groq rate limit")
    if res.status_code >= 400:
        raise LLMError(f"groq {res.status_code}: {res.text[:300]}")
    return res.json()


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
