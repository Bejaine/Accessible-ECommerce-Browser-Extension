"""POST /product/prepare: precompute every section in parallel, cache per product (rule 10).

Sections are English and grounding-checked; /turn translates only the one the user asks for.
The cache key includes a hash of the ProductJSON, so a price or stock change on the live page
is never answered from a stale section.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import Awaitable, Callable

from app.brain import review_summariser, sections
from app.brain.grounding import CheckResult
from app.brain.llm import LLMError
from app.brain.llm_sections import llm_section
from app.models import (
    SCHEMA_VERSION,
    AccessibleOutput,
    ProductJSON,
    ProductPrepareRequest,
    ProductPrepareResponse,
)
from app.services.cache import TTLCache

log = logging.getLogger(__name__)

Builder = Callable[[ProductJSON], Awaitable[CheckResult]]


def llm_first(name: str, template: Builder) -> Builder:
    """Groq-written section if it passes every check, else the deterministic template."""

    async def build(product: ProductJSON) -> CheckResult:
        try:
            return await llm_section(name, product)
        except LLMError as exc:
            log.info("section %s for %s uses the template: %s", name, product.id, exc)
            return await template(product)

    return build


BUILDERS: dict[str, Builder] = {
    "overview": llm_first("overview", sections.overview),
    "specs": llm_first("specs", sections.specs),
    "reviews": llm_first("reviews", review_summariser.summarise_product),
    # Image descriptions come from the VLM (Gemini) in brain/vision.py; alt/OCR text until then.
    "images": sections.images,
}

_cache = TTLCache(ttl_seconds=3600)


def cache_key(product: ProductJSON) -> str:
    digest = hashlib.sha256(product.model_dump_json().encode()).hexdigest()[:16]
    return f"{product.id}:{digest}"


async def _build(name: str, builder: Builder, product: ProductJSON) -> AccessibleOutput | None:
    try:
        result = await builder(product)
    except Exception:  # one broken section must not cost the user the others
        log.exception("section %s failed for %s", name, product.id)
        return None
    for reason in result.dropped:
        log.warning("grounding dropped (%s, %s): %s", name, product.id, reason)
    return result.output


async def prepare_sections(product: ProductJSON) -> dict[str, AccessibleOutput | None]:
    key = cache_key(product)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    built = await asyncio.gather(*(_build(n, b, product) for n, b in BUILDERS.items()))
    result: dict[str, AccessibleOutput | None] = dict(zip(BUILDERS, built, strict=True))
    # Comparison needs candidates (search results or SerpApi "similar"); not precomputed yet.
    result["comparison"] = None
    _cache.set(key, result)
    return result


async def prepare(req: ProductPrepareRequest) -> ProductPrepareResponse:
    result = await prepare_sections(req.product)
    return ProductPrepareResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "product_id": req.product.id,
            "product": req.product,
            "sections": result,
        }
    )


async def one_section(product: ProductJSON, name: str) -> AccessibleOutput | None:
    """One section for /turn: from the full precompute if cached, else only that builder
    (at most one LLM call, keeping /turn within its budget of two)."""
    cached = _cache.get(cache_key(product))
    if cached is not None:
        return cached[name]
    key = f"{cache_key(product)}:{name}"
    hit = _cache.get(key)
    if hit is None:
        hit = await _build(name, BUILDERS[name], product)
        if hit is not None:
            _cache.set(key, hit)
    return hit
