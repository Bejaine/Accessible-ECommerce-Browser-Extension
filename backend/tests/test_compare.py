"""Comparison: feature mapping across sites, ranking by stated preferences, session memory."""

import asyncio
import json
from pathlib import Path

import pytest

from app.brain import compare, features, prepare, session, tools
from app.brain.grounding import check
from app.models import ProductJSON, TurnRequest
from app.services.serpapi import similar_products, to_product

REPO = Path(__file__).resolve().parents[2]


def run(coro):
    return asyncio.run(coro)


def product(pid, title, price, rating, specs):
    return ProductJSON.model_validate(
        {
            "schema_version": "1.0",
            "id": pid,
            "url": "https://www.example.com/p",
            "site": pid.split(":")[0],
            "title": title,
            "brand": None,
            "price": {"amount": price, "currency": "INR", "mrp": None} if price else None,
            "rating": {"value": rating, "count": 100} if rating else None,
            "availability": None,
            "category": None,
            "specs": {k: {"label": k, "value": v, "unit": u} for k, (v, u) in specs.items()},
            "variants": None,
            "images": [],
            "delivery": None,
            "seller": None,
            "sponsored": None,
            "reviews": None,
            "source": {"method": "adapter", "extracted_at": "2026-10-11T00:00:00Z", "fields": {}},
            "missing": [],
        }
    )


# Spec names as the real pages write them (Track B's Amazon/Flipkart fixtures, SerpApi).
SAMSUNG = product("amazon.in:S", "Samsung Galaxy A56 5G Mobile (Blue)", 32999, 4.4, {
    "rear_facing_camera_photo_sensor_resolution": ("12, 5, 50 MP", None),
    "front_photo_sensor_resolution": (12, "MP"),
    "battery_capacity": ("5000 milliamp_hours", None),
    "ram_memory_installed_size": (8, "GB"),
    "screen_size_unit_of_measure": (6.7, "Inches"),
    "item_weight_unit_of_measure": (196, "Grams"),
})  # fmt: skip
NOVA = product("flipkart.com:N", "Ai+ Nova 2 5G (Black, 64 GB)", 12999, 4.2, {
    "primary_camera": ("50MP Rear Camera", None),
    "secondary_camera": ("8MP Front Camera", None),
    "battery_capacity": (6000, "mAh"),
    "ram": (4, "GB"),
    "display_size": ("17.13 cm (6.745 inch)", None),
})  # fmt: skip
ZENTRA = product("amazon.in:Z", "Zentra Pulse 5G (Black)", 17999, 4.2, {
    "battery": (5000, "mAh"),
    "ram": (8, "GB"),
})  # fmt: skip


def test_features_from_differently_named_specs():
    s, n = features.extract(SAMSUNG), features.extract(NOVA)
    assert (s["camera"].number, n["camera"].number) == (50, 50)
    assert (s["battery"].number, n["battery"].number) == (5000, 6000)
    assert (s["screen"].number, n["screen"].number) == (6.7, 6.745)
    assert s["weight"].path == "specs.item_weight_unit_of_measure.value"
    assert n["screen"].text == "17.13 cm (6.745 inch)", "said as the page writes it"


def test_main_camera_is_not_a_number_buried_in_a_paragraph():
    p = product("amazon.in:I", "iPhone", 76999, 3.2, {
        "camera_and_video": (
            "Advanced dual-camera system: 48MP Fusion: 26 mm, ƒ/1.6 aperture ... "
            "Panorama (up to 63MP)",
            None,
        ),
    })  # fmt: skip
    assert features.extract(p)["camera"].number == 48


def test_no_preference_ranks_on_price_and_rating_and_is_grounded():
    result = compare.build([SAMSUNG, NOVA, ZENTRA])
    out = result.output
    assert out.summary.startswith("On price and rating, ")
    assert check(out, {p.id: p for p in (SAMSUNG, NOVA, ZENTRA)}, result.derived).dropped == []


def test_stated_priorities_change_the_winner():
    battery_first = compare.build([SAMSUNG, NOVA, ZENTRA], {"battery": 1.0})
    assert battery_first.output.summary.startswith("For what you asked, Ai+ Nova 2 5G comes first.")
    assert "6000 mAh against" in battery_first.output.summary


def test_a_tie_on_the_top_priority_is_said():
    out = compare.build([SAMSUNG, NOVA], {"camera": 1.0, "battery": 0.0}).output
    assert "Both have the same main camera" in out.summary
    rows = [r[0] for r in out.sections[0].table.rows]
    assert rows[0] == "Main camera" and "Battery" not in rows, "ignored features aren't read out"


def test_budget_filters_and_says_so():
    out = compare.build([SAMSUNG, NOVA, ZENTRA], {"battery": 1.0}, max_price=20000).output
    assert out.sections[0].table.columns == ["", "Ai+ Nova 2 5G", "Zentra Pulse 5G"]
    assert out.warnings == ["1 more did not fit your budget or rating."]


def test_missing_features_are_not_listed_never_guessed():
    out = compare.build([SAMSUNG, ZENTRA], {"camera": 1.0}).output
    camera = next(r for r in out.sections[0].table.rows if r[0] == "Main camera")
    assert camera[1:] == ["12, 5, 50 MP", "not listed"]


# --- Amazon: compare_with_similar from SerpApi (real recording) ---


def test_amazon_comparison_section_keeps_this_product():
    raw = json.loads((REPO / "fixtures/serpapi/amazon_product.B0DGJHBX5Y.json").read_text())
    iphone = ProductJSON.model_validate(to_product(raw))
    assert [p["title"] for p in similar_products(raw, "B0DGJHBX5Y")] == [
        "iPhone 16 Plus", "iPhone 16 Pro", "iPhone 16 Pro Max",
    ]  # fmt: skip
    out = run(prepare.comparison_section(iphone)).output
    assert "Apple iPhone 16 128 GB" in out.sections[0].table.columns
    assert out.sections[0].items[0].text == "This one, Apple iPhone 16 128 GB, ranks 4 of 4."
    assert out.warnings == [
        prepare.SIMILAR_NOTE,
        "Apple iPhone 16 128 GB's page lists the same size, 128 GB, for RAM and storage. "
        "One of them may be a listing error.",
    ]


def test_no_comparison_section_off_amazon():
    assert run(prepare.comparison_section(NOVA)) is None


# --- /turn: preferences and products remembered for the session ---


@pytest.fixture
def ctx_on(mock_body):
    def make(p: ProductJSON, sid="s1"):
        data = mock_body("TurnRequest")
        data["session_id"] = sid
        data["page"]["products"] = [p.model_dump(mode="json", by_alias=True)]
        return tools.Context(TurnRequest.model_validate(data))

    session.reset()
    return make


def test_compare_with_a_product_seen_on_another_site(ctx_on):
    session.get("s1").remember(NOVA)  # looked at on Flipkart earlier
    out = run(tools.compare(ctx_on(SAMSUNG))).output  # now on Amazon
    assert set(out.sections[0].table.columns[1:]) == {
        "Samsung Galaxy A56 5G Mobile",
        "Ai+ Nova 2 5G",
    }


def test_preferences_are_remembered_for_the_session(ctx_on):
    said = run(tools.set_preferences(
        ctx_on(SAMSUNG), priorities=[{"feature": "battery", "importance": "high"},
                                     {"feature": "camera", "importance": "ignore"}],
        max_price=20000,
    ))  # fmt: skip
    assert said.output.summary == (
        "Got it: battery matters most; main camera doesn't matter; your budget is ₹20,000. "
        "I'll use this when I compare."
    )
    session.get("s1").remember(NOVA)
    session.get("s1").remember(ZENTRA)
    out = run(tools.compare(ctx_on(SAMSUNG))).output
    assert out.summary.startswith("For what you asked, Ai+ Nova 2 5G comes first.")


def test_compare_needs_two_products(ctx_on):
    out = run(tools.compare(ctx_on(SAMSUNG, sid="lonely"))).output
    assert out.summary.startswith("I need at least two products to compare.")
