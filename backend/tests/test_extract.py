"""/extract/fallback: the model's answer is only used where the page text backs it up."""

from datetime import date
from pathlib import Path

import pytest

from app.brain.extract import verify
from app.models import ExtractFallbackRequest

TEXT = "\n".join(
    [
        "Ai+ Nova 2 5G (Black, 64 GB) (4 GB RAM)",
        "Variant: 128 GB + 4 GB",
        "₹13,999",
        "4.2 ★ 7,285 Ratings & 612 Reviews",
        "₹12,999 ₹13,999 7% off",
        "Free delivery by Wednesday, 14 Oct",
        "Seller IndiFlashMart",
        "Battery Capacity 6000 mAh",
        "Expandable Storage 1 TB",
    ]
)
TODAY = date(2026, 10, 10)


def req(missing):
    return ExtractFallbackRequest.model_validate(
        {
            "schema_version": "1.0",
            "url": "https://www.flipkart.com/x/p/itm1",
            "site": "flipkart.com",
            "missing": missing,
            "text": TEXT,
            "truncated": False,
        }
    )


def item(field, value, snippet, label=None, selected=False):
    return {"field": field, "label": label, "value": value, "snippet": snippet}


def test_keeps_backed_fields_and_lists_evidence():
    raw = {
        "items": [
            item("rating", "4.2", "4.2 ★ 7,285 Ratings & 612 Reviews"),
            item("rating_count", "7,285", "4.2 ★ 7,285 Ratings & 612 Reviews"),
            item(
                "delivery",
                "Free delivery by Wednesday, 14 Oct",
                "Free delivery by Wednesday, 14 Oct",
            ),
            item("seller", "IndiFlashMart", "Seller IndiFlashMart"),
            item("spec", "6000 mAh", "Battery Capacity 6000 mAh", label="Battery Capacity"),
        ]
    }
    res = verify(raw, req(["rating", "delivery", "seller", "specs"]), TODAY)
    f = res.found
    assert (f.rating.value, f.rating.count) == (4.2, 7285)
    assert f.delivery.cost.amount == 0 and f.delivery.date.isoformat() == "2026-10-14"
    assert f.seller == "IndiFlashMart"
    assert f.specs["battery_capacity"].value == 6000 and f.specs["battery_capacity"].unit == "mAh"
    assert res.missing == []
    assert {"field_path": "seller", "snippet": "Seller IndiFlashMart"} in [
        e.model_dump() for e in res.evidence
    ]


def test_price_is_never_extracted():
    """Seen live: on a Flipkart page the model returned the bank-offer price (₹11,999) as the
    price (₹12,999). Price comes only from JSON-LD and adapters, never from this fallback."""
    raw = {"items": [item("price", "₹12,999", "₹12,999 ₹13,999 7% off", selected=True)]}
    res = verify(raw, req(["price", "price.mrp"]), TODAY)
    assert res.found.price is None
    assert res.missing == ["price", "price.mrp"]
    assert res.evidence == []


def test_highlight_lines_are_not_specs():
    raw = {
        "items": [
            item(
                "spec", "4 GB RAM | 64 GB ROM", "Seller IndiFlashMart", label="4 GB RAM | 64 GB ROM"
            )
        ]
    }
    assert verify(raw, req(["specs"]), TODAY).found.specs == {}


@pytest.mark.parametrize(
    "bad",
    [
        item("seller", "SuperSeller", "Seller SuperSeller"),  # snippet not on the page
        item("seller", "SuperSeller", "Seller IndiFlashMart"),  # value not in its snippet
        item("spec", "8000 mAh", "Battery Capacity 6000 mAh", label="Battery Capacity"),  # number
        item("spec", "6000 mAh", "Battery Capacity 6000 mAh", label=None),  # no label
    ],
)
def test_unbacked_values_are_dropped(bad):
    res = verify({"items": [bad]}, req(["seller", "specs"]), TODAY)
    assert res.found.seller is None and res.found.specs == {}
    assert res.evidence == []
    assert res.missing == ["seller", "specs"]


def test_only_asked_for_fields_are_returned():
    raw = {"items": [item("seller", "IndiFlashMart", "Seller IndiFlashMart")]}
    res = verify(raw, req(["specs"]), TODAY)
    assert res.found.seller is None


def test_rating_needs_its_count():
    raw = {"items": [item("rating", "4.2", "4.2 ★ 7,285 Ratings & 612 Reviews")]}
    res = verify(raw, req(["rating"]), TODAY)
    assert res.found.rating is None


def test_whitespace_and_case_in_snippets_are_tolerated():
    raw = {"items": [item("seller", "IndiFlashMart", "seller   indiflashmart")]}
    assert verify(raw, req(["seller"]), TODAY).found.seller == "IndiFlashMart"


def test_route_without_recording_serves_the_mock(client, assert_schema, mock_body):
    res = client.post("/extract/fallback", json=mock_body("ExtractFallbackRequest"))
    assert res.status_code == 200
    assert_schema("ExtractFallbackResponse", res.json())


def test_route_rejects_bad_requests(client, assert_schema):
    res = client.post("/extract/fallback", json={"schema_version": "1.0", "url": "x"})
    assert res.status_code == 422
    assert_schema("ErrorResponse", res.json())


# --- real pages (Track B's saved fixtures), Groq answers replayed from fixtures/llm/extract/ ---

REAL = Path(__file__).resolve().parents[2] / "fixtures/llm/extract/requests"


def real(name):
    import asyncio

    from app.brain import extract as extract_mod

    request = ExtractFallbackRequest.model_validate_json((REAL / f"{name}.json").read_text())
    extract_mod._cache = extract_mod.TTLCache(60)
    return asyncio.run(extract_mod.extract(request, today=TODAY))


def test_real_amazon_cooker():
    res = real("amazon-product-cooker")
    f = res.found
    assert (f.rating.value, f.rating.count) == (4.3, 3208)
    assert f.availability.status.value == "low_stock"
    assert f.seller == "SHIV HOME WORLD", "the 'Sold by' label is not part of the name"
    assert f.delivery.date.isoformat() == "2026-10-13"
    assert f.price is None and "price" in res.missing


def test_real_amazon_earphones_ignore_the_prime_advert():
    """Seen live: the model took "Enjoy Unlimited FREE Same day/1-day delivery, Prime offers
    everyday and more" as the delivery promise. It has no day or date, so it is dropped."""
    res = real("amazon-product-earphones")
    assert res.found.delivery is None or "Prime" not in res.found.delivery.text


def test_real_flipkart_phone_never_gets_a_wrong_price():
    res = real("flipkart-product-phone")
    assert res.found.price is None
    assert (res.found.rating.value, res.found.rating.count) == (4.2, 7285)
    assert res.found.seller == "IndiFlashMart"
