"""SerpApi read-only enrichment (rule 9, Track C). One amazon_product call per ASIN, cached.

With MOCK=1 responses come from fixtures/serpapi/amazon_product.<ASIN>.json.
"""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from typing import Any

from app.config import get_settings
from app.errors import ApiError
from app.models import ErrorCode
from app.services.cache import TTLCache

_cache = TTLCache(ttl_seconds=24 * 3600)


async def amazon_product(asin: str) -> dict[str, Any]:
    cached = _cache.get(asin)
    if cached is not None:
        return cached
    settings = get_settings()
    if settings.mock:
        path = settings.fixtures_dir / "serpapi" / f"amazon_product.{asin}.json"
        if not path.exists():
            raise ApiError(
                ErrorCode.not_found, f"No recorded SerpApi response for {asin}.", status=404
            )
        result = json.loads(path.read_text())
    else:
        raise ApiError(ErrorCode.internal, "Live SerpApi calls are not wired up yet.", status=501)
    _cache.set(asin, result)
    return result


# --- amazon_product response -> ProductJSON -------------------------------------------------
# Only what the response states is mapped; anything else is null and listed in `missing`.
# Prices/stock/delivery here are SerpApi's snapshot; for payable details the live page wins.

_SPEC_SKIP = {
    "asin", "packer", "importer", "manufacturer", "net_quantity", "product_dimensions",
    "item_weight", "item_dimensions_lx_wx_h",
}  # fmt: skip
_NUMBER_UNIT = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([A-Za-z\"″]+)\s*$")
_DELIVERY_DATE = re.compile(r"(\d{1,2}) (January|February|March|April|May|June|July|August|"
                            r"September|October|November|December)")  # fmt: skip


def _spec(key: str, raw: Any) -> dict[str, Any]:
    text = ", ".join(raw) if isinstance(raw, list) else str(raw)
    label = key.replace("_", " ").capitalize()
    match = _NUMBER_UNIT.match(text)
    if match:
        number = float(match.group(1))
        return {"label": label, "value": int(number) if number.is_integer() else number,
                "unit": match.group(2)}  # fmt: skip
    return {"label": label, "value": text, "unit": None}


def _date(text: str | None, year: int) -> str | None:
    if not text:
        return None
    for fmt in ("%d %B %Y",):
        try:
            return datetime.strptime(text, fmt).date().isoformat()
        except ValueError:
            pass
    match = _DELIVERY_DATE.search(text)
    if match:
        return (
            datetime.strptime(f"{match.group(1)} {match.group(2)} {year}", "%d %B %Y")
            .date()
            .isoformat()
        )
    return None


def to_product(raw: dict[str, Any]) -> dict[str, Any]:
    """Map a SerpApi amazon_product response to a ProductJSON dict (validated by the caller)."""
    pr = raw.get("product_results") or {}
    asin = pr.get("asin") or raw["search_parameters"]["asin"]
    domain = raw.get("search_parameters", {}).get("amazon_domain", "amazon.in")
    created = raw.get("search_metadata", {}).get("created_at", "")
    extracted_at = (
        datetime.strptime(created, "%Y-%m-%d %H:%M:%S UTC").replace(tzinfo=UTC).isoformat()
        if created
        else datetime.now(UTC).isoformat()
    )
    year = int(extracted_at[:4])
    missing: list[str] = []

    specs_raw = dict(raw.get("item_specifications") or {})
    brand = specs_raw.pop("brand", None)
    specs_raw.update(raw.get("product_details") or {})
    specs = {k: _spec(k, v) for k, v in specs_raw.items() if k not in _SPEC_SKIP and v}

    price = None
    if pr.get("extracted_price") is not None:
        price = {"amount": pr["extracted_price"], "currency": "INR",
                 "mrp": pr.get("extracted_old_price")}  # fmt: skip
    else:
        missing.append("price")

    rating = None
    if pr.get("rating") is not None:
        rating = {"value": pr["rating"], "count": int(pr.get("reviews") or 0)}
    else:
        missing.append("rating")

    stock = pr.get("stock")
    status = "in_stock" if stock and "in stock" in stock.lower() else "unknown"
    availability = {"status": status, "text": stock} if stock else None

    delivery = None
    if pr.get("delivery"):
        text = pr["delivery"][0].removesuffix(" Details").rstrip(".")
        free = text.upper().startswith("FREE")
        delivery = {"text": text, "cost": {"amount": 0, "currency": "INR"} if free else None,
                    "date": _date(text, year)}  # fmt: skip
    else:
        missing.append("delivery")

    offer = (raw.get("purchase_options") or {}).get("single_offer") or {}
    seller = ((offer.get("features") or {}).get("sold_by") or {}).get("text")

    variants = []
    for group in pr.get("variants") or []:
        for item in group.get("items") or []:
            variants.append({"name": group["title"].lower(), "value": item["name"],
                             "selected": bool(item.get("selected")), "available": None,
                             "target_id": None})  # fmt: skip

    info = raw.get("reviews_information") or {}
    summary = info.get("summary") or {}
    items = [
        {"rating": r.get("rating"), "title": r.get("title"), "text": r["text"],
         "date": _date(r.get("date"), year), "verified": r.get("verified_purchase")}
        for r in info.get("authors_reviews") or [] if r.get("text")
    ]  # fmt: skip
    insights = [
        {"topic": i["title"], "sentiment": i["sentiment"], "mentions": i["mentions"]}
        for i in summary.get("insights") or []
        if i.get("sentiment") in ("positive", "negative", "mixed") and i.get("mentions")
    ]
    reviews = None
    if items or insights or summary.get("text"):
        # customer_reviews holds star PERCENTAGES, not counts, so it is not a histogram.
        # Amazon's summary covers more reviews than the few texts shown; the largest mention
        # count is a lower bound for how many it read, so we never claim more than that.
        most_mentions = max((i["mentions"]["total"] for i in insights), default=0)
        reviews = {
            "basis_count": max(len(items), most_mentions),
            "summary_text": summary.get("text"),
            "insights": insights,
            "histogram": None,
            "items": items,
        }
        missing.append("reviews.histogram")
    else:
        missing.append("reviews")

    images = [{"url": u, "alt": None, "description": None, "ocr_text": None}
              for u in pr.get("thumbnails") or []]  # fmt: skip
    if not seller:
        missing.append("seller")
    missing.append("category")

    return {
        "schema_version": "1.0",
        "id": f"{domain}:{asin}",
        "url": pr.get("link_clean") or f"https://www.{domain}/dp/{asin}",
        "site": domain,
        "title": pr.get("title"),
        "brand": brand,
        "price": price,
        "rating": rating,
        "availability": availability,
        "category": None,
        "specs": specs,
        "variants": variants or None,
        "images": images,
        "delivery": delivery,
        "seller": seller,
        "sponsored": None,
        "reviews": reviews,
        "source": {"method": "serpapi", "extracted_at": extracted_at, "fields": {}},
        "missing": missing,
    }
