"""Product photo descriptions with a VLM (Gemini Interactions API), cached by image URL.

What a blind shopper needs from a photo: colour, shape, parts, what's in the box, visible text.
The model may only describe what is visible. Its output is checked before use:
- every number it states must appear in page data: the title, the photo's alt text or a spec
  value, so "48MP" read off a banner is dropped unless the page says it. OCR text is NOT used:
  it misreads numbers and units ("5000 mAh" -> "500 mAb", Track A's live findings);
- text it says it can read is kept only when the same text is in that evidence;
- what it says is unclear is passed on ("The photo doesn't clearly show ...").
Only images on the shops' own image hosts are downloaded (no fetching arbitrary URLs).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import httpx

from app.brain.format import brief, spec_value
from app.brain.grounding import numbers_in
from app.brain.llm import LLMError, fixture_path
from app.brain.output import OutputBuilder
from app.config import get_settings
from app.models import (
    SCHEMA_VERSION,
    ProductJSON,
    VisionDescribeRequest,
    VisionDescribeResponse,
)
from app.services.cache import TTLCache

log = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
IMAGE_HOSTS = ("media-amazon.com", "ssl-images-amazon.com", "flixcart.com")
MAX_IMAGE_BYTES = 4 * 1024 * 1024
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/gif")
AI_NOTE = "This photo description was made by AI and may miss details."

_cache = TTLCache(ttl_seconds=24 * 3600)  # image URL -> Described

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "is_product_photo": {"type": "boolean"},
        "description": {
            "type": "string",
            "description": "1-2 short sentences: what is visibly shown.",
        },
        "colours": {"type": "array", "items": {"type": "string"}},
        "items_shown": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Separate things visible, e.g. phone, charger, cable, box.",
        },
        "visible_text": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Text printed in the photo, copied exactly.",
        },
        "unclear": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Buying-relevant things the photo does not show clearly.",
        },
    },
    "required": [
        "is_product_photo",
        "description",
        "colours",
        "items_shown",
        "visible_text",
        "unclear",
    ],
}

SYSTEM_PROMPT = """\
You describe ONE product photo for a blind shopper who cannot see it.
Describe ONLY what is visible in this photo: colour, shape, material look, the parts or items \
shown (for example what is in the box), ports and buttons, and any printed text.
Rules:
- Never state specifications, features or quality that are not visibly shown. Do not use what \
you know about the brand or model. The product title is given only so you can name the object.
- Copy printed text exactly. If you cannot read it clearly, do not guess it.
- If something a buyer would care about is not clear in the photo, list it in "unclear".
- No marketing words, no opinions. Plain English, short sentences.
- If the photo is not of the product (a banner, a chart, a lifestyle scene), say what it is.
"""


@dataclass
class Described:
    url: str
    description: str
    colours: list[str] = field(default_factory=list)
    items_shown: list[str] = field(default_factory=list)
    visible_text: list[str] = field(default_factory=list)
    unclear: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)


def _host_ok(url: str) -> bool:
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    return parsed.scheme == "https" and any(
        host == h or host.endswith("." + h) for h in IMAGE_HOSTS
    )


def recording_key(url: str) -> str:
    return f"vision/{hashlib.sha256(url.encode()).hexdigest()[:16]}"


async def fetch_image(url: str) -> tuple[bytes, str]:
    if not _host_ok(url):
        raise LLMError(f"not a shop image host: {urlparse(url).hostname}")
    try:
        async with httpx.AsyncClient(timeout=10, follow_redirects=False) as client:
            res = await client.get(url)
    except httpx.HTTPError as exc:
        raise LLMError(f"image download failed: {exc!r}") from exc
    mime = res.headers.get("content-type", "").split(";")[0].strip()
    if res.status_code != 200 or mime not in IMAGE_TYPES:
        raise LLMError(f"image not usable: HTTP {res.status_code}, {mime or 'no type'}")
    if len(res.content) > MAX_IMAGE_BYTES:
        raise LLMError("image too large")
    return res.content, mime


async def _ask_vlm(url: str, title: str | None) -> dict[str, Any]:
    key = recording_key(url)
    if get_settings().mock:
        path = fixture_path(key)
        if not path.exists():
            raise LLMError(f"no recorded VLM response for {url}")
        return json.loads(path.read_text())["response"]
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key:
        raise LLMError("GEMINI_API_KEY is not set")
    data, mime = await fetch_image(url)
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash-lite")
    body = {
        "model": model,
        "system_instruction": SYSTEM_PROMPT,
        "input": [
            {"type": "text", "text": f"Product title (for naming only): {title or 'unknown'}"},
            {"type": "image", "data": base64.b64encode(data).decode(), "mime_type": mime},
        ],
        "response_format": {"type": "text", "mime_type": "application/json", "schema": SCHEMA},
        "generation_config": {"thinking_level": "minimal", "max_output_tokens": 800},
        "store": False,  # don't keep shoppers' requests
    }
    try:
        async with httpx.AsyncClient(timeout=float(os.getenv("LLM_TIMEOUT_S", "20"))) as client:
            res = await client.post(GEMINI_URL, json=body, headers={"x-goog-api-key": api_key})
    except httpx.HTTPError as exc:
        raise LLMError(f"gemini request failed: {exc!r}") from exc
    if res.status_code >= 400:
        raise LLMError(f"gemini {res.status_code}: {res.text[:300]}")
    raw = res.json()
    if os.getenv("LLM_RECORD", "0") == "1":
        path = fixture_path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {"model": model, "image_url": url, "response": raw}, indent=2, ensure_ascii=False
            )
            + "\n"
        )
    return raw


def _parse(raw: dict[str, Any]) -> dict[str, Any]:
    for step in raw.get("steps") or []:
        if step.get("type") == "model_output":
            for part in step.get("content") or []:
                if part.get("type") == "text":
                    try:
                        return json.loads(part["text"])
                    except json.JSONDecodeError as exc:
                        raise LLMError("VLM answer is not JSON") from exc
    raise LLMError("VLM answer has no text output")


def verify(answer: dict[str, Any], url: str, evidence: str) -> Described:
    """Keep only what the page can back up where it matters (numbers, printed text)."""
    known_numbers = numbers_in(evidence)
    plain = re.sub(r"\s+", " ", evidence.lower())
    dropped: list[str] = []

    def numbers_ok(text: str) -> bool:
        return numbers_in(text) <= known_numbers

    sentences = [s for s in re.split(r"(?<=[.!?])\s+", answer.get("description", "").strip()) if s]
    kept = [s for s in sentences if numbers_ok(s)]
    dropped += [f"number not on the page: {s}" for s in sentences if s not in kept]

    def keep_list(values: list[str], *, must_be_in_evidence: bool) -> list[str]:
        out = []
        for v in values or []:
            v = v.strip()
            if not v:
                continue
            if must_be_in_evidence and re.sub(r"\s+", " ", v.lower()) not in plain:
                dropped.append(f"text not confirmed by the page: {v}")
            elif not numbers_ok(v):
                dropped.append(f"number not on the page: {v}")
            else:
                out.append(v)
        return out

    if answer.get("is_product_photo") is False and not kept:
        kept = ["This photo does not show the product itself."]
    return Described(
        url=url,
        description=" ".join(kept),
        colours=keep_list(answer.get("colours", []), must_be_in_evidence=False)[:4],
        items_shown=keep_list(answer.get("items_shown", []), must_be_in_evidence=False)[:8],
        visible_text=keep_list(answer.get("visible_text", []), must_be_in_evidence=True)[:6],
        unclear=keep_list(answer.get("unclear", []), must_be_in_evidence=False)[:3],
        dropped=dropped,
    )


def _evidence(p: ProductJSON | None, url: str) -> str:
    if p is None:
        return ""
    parts = [p.title or ""]
    parts += [img.alt or "" for img in p.images if img.url == url]
    parts += [f"{spec.label} {spec_value(spec.value, spec.unit)}" for spec in p.specs.values()]
    return " ".join(parts)


async def describe_url(url: str, p: ProductJSON | None = None) -> Described:
    hit = _cache.get(url)
    if hit is not None:
        return hit
    answer = _parse(await _ask_vlm(url, p.title if p else None))
    described = verify(answer, url, _evidence(p, url))
    if not described.description:
        raise LLMError("nothing usable in the VLM answer")
    for reason in described.dropped:
        log.warning("vision dropped (%s): %s", url, reason)
    _cache.set(url, described)
    return described


def cached(url: str) -> Described | None:
    return _cache.get(url)


def spoken(d: Described) -> str:
    """Description plus the parts that matter, in one or two sentences."""
    text = d.description
    if d.items_shown and "box" in text.lower():
        text += f" Items shown: {', '.join(d.items_shown)}."
    if d.unclear:
        text += f" Not clear in the photo: {', '.join(d.unclear)}."
    return brief(text, 380) if len(text) > 380 else text


def with_descriptions(p: ProductJSON) -> ProductJSON:
    """A copy of the product with the cached photo descriptions filled in, so outputs can
    cite images[i].description."""
    data = p.model_dump(mode="json", by_alias=True)
    for img in data["images"]:
        hit = _cache.get(img["url"])
        if hit is not None and not img["description"]:
            img["description"] = spoken(hit)
    return ProductJSON.model_validate(data)


async def describe(req: VisionDescribeRequest) -> VisionDescribeResponse:
    """POST /vision/describe for any shop image URL (no product data: numbers and printed text
    can't be confirmed, so they are left out)."""
    was_cached = cached(req.image_url) is not None
    d = await describe_url(req.image_url)
    b = OutputBuilder()
    items = [b.item(f"Colour: {c}") for c in d.colours]
    items += [b.item(f"Shown: {x}") for x in d.items_shown]
    items += [b.item(f"Not clear in the photo: {u}") for u in d.unclear]
    if items:
        b.section("In the photo", items)
    out = b.checked({}, spoken(d), warnings=[AI_NOTE]).output
    return VisionDescribeResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "image_url": req.image_url,
            "output": out,
            "cached": was_cached,
        }
    )
