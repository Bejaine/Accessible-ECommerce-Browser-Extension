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

from app.brain import brevity, compare, review_summariser, sections, vision
from app.brain.grounding import CheckResult
from app.brain.llm import LLMError
from app.brain.llm_sections import llm_section
from app.errors import ApiError
from app.models import (
    SCHEMA_VERSION,
    AccessibleOutput,
    ProductJSON,
    ProductPrepareRequest,
    ProductPrepareResponse,
)
from app.services import serpapi
from app.services.cache import TTLCache

log = logging.getLogger(__name__)

Builder = Callable[[ProductJSON], Awaitable[CheckResult | None]]


def llm_first(name: str, template: Builder) -> Builder:
    """Groq-written section if it passes every check, else the deterministic template."""

    async def build(product: ProductJSON) -> CheckResult:
        try:
            return await llm_section(name, product)
        except LLMError as exc:
            log.info("section %s for %s uses the template: %s", name, product.id, exc)
            return await template(product)

    return build


async def images_with_vlm(product: ProductJSON) -> CheckResult:
    """Main photo described by the VLM (cached by URL); alt/OCR text if that fails."""
    described = False
    if product.images:
        try:
            await vision.describe_url(product.images[0].url, product)
            described = True
        except LLMError as exc:
            log.info("photo description for %s unavailable: %s", product.id, exc)
    return await sections.images(
        vision.with_descriptions(product), warnings=[vision.AI_NOTE] if described else None
    )


SIMILAR_NOTE = "Prices of the other models are from Amazon's comparison and may have changed."


async def comparison_section(product: ProductJSON) -> CheckResult | None:
    """Amazon: this product (live page) against Amazon's "compare with similar items" (SerpApi,
    one cached call per ASIN). Elsewhere comparisons come from /turn (products seen before)."""
    site, _, asin = product.id.partition(":")
    if not site.startswith("amazon") or not asin:
        return None
    try:
        raw = await serpapi.amazon_product(asin)
    except ApiError as exc:
        log.info("no SerpApi comparison for %s: %s", product.id, exc.message)
        return None
    similar = [ProductJSON.model_validate(d) for d in serpapi.similar_products(raw, asin)]
    if not similar:
        return None
    return compare.build(
        [product, *similar],
        heading="Compared with similar models",
        warnings=[SIMILAR_NOTE],
        keep=product.id,
    )


BUILDERS: dict[str, Builder] = {
    "overview": llm_first("overview", sections.overview),
    "specs": llm_first("specs", sections.specs),
    "reviews": llm_first("reviews", review_summariser.summarise_product),
    "images": images_with_vlm,
    "comparison": comparison_section,
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
    if result is None:
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
    _cache.set(key, result)
    return result


async def prepare(req: ProductPrepareRequest) -> ProductPrepareResponse:
    vision.remember_product(req.product)  # so /vision/describe can ground its answer
    result = await prepare_sections(req.product)
    if brevity.wants_short(req.prefs):  # the cache keeps the full sections; shorten per request
        result = {k: brevity.shorten(v) if v else None for k, v in result.items()}
    return ProductPrepareResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "product_id": req.product.id,
            # With the photo descriptions filled in, so images[i].description claims resolve.
            "product": vision.with_descriptions(req.product),
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
