"""SerpApi amazon_product -> ProductJSON, on a real recorded response (iPhone 16, amazon.in)."""

import json
from pathlib import Path

import pytest

from app.models import ProductJSON
from app.services.serpapi import to_product

REPO = Path(__file__).resolve().parents[2]
RECORDING = REPO / "fixtures/serpapi/amazon_product.B0DGJHBX5Y.json"


@pytest.fixture
def iphone() -> ProductJSON:
    return ProductJSON.model_validate(to_product(json.loads(RECORDING.read_text())))


def test_maps_core_fields(iphone):
    assert iphone.id == "amazon.in:B0DGJHBX5Y"
    assert iphone.brand == "Apple"  # not "Visit the Apple Store"
    assert (iphone.price.amount, iphone.price.mrp) == (76999, 89900)
    assert (iphone.rating.value, iphone.rating.count) == (3.2, 2764)
    assert iphone.availability.status.value == "in_stock"
    assert iphone.delivery.text == "FREE delivery Monday, 12 October"
    assert iphone.delivery.date.isoformat() == "2026-10-12"
    assert iphone.delivery.cost.amount == 0
    assert iphone.seller == "Clicktech Retail Private Ltd"
    assert iphone.source.method.value == "serpapi"


def test_specs_parse_numbers_and_skip_noise(iphone):
    assert iphone.specs["screen_size"].value == 6.1
    assert iphone.specs["screen_size"].unit == "Inches"
    assert "IP68" in iphone.specs["splash_water_and_dust_resistant"].value
    assert not {"asin", "importer", "packer"} & set(iphone.specs)


def test_variants(iphone):
    colours = [v.value for v in iphone.variants if v.name == "colour"]
    assert colours == ["Black", "Pink", "Teal", "Ultramarine", "White"]
    assert [v.value for v in iphone.variants if v.selected] == ["Black", "Without Apple Care"]


def test_reviews_never_overclaim(iphone):
    r = iphone.reviews
    # Star "counts" in the response are percentages (76/15/4/1/4), so no histogram.
    assert r.histogram is None
    assert "reviews.histogram" in iphone.missing
    # basis_count = review texts actually read (team decision, same as the page extractor).
    assert r.basis_count == 8
    assert len(r.items) == 8
    assert [i.topic for i in r.insights if i.sentiment.value == "negative"] == ["Heat"]


def test_no_personal_data_in_recording():
    text = RECORDING.read_text()
    for field in ('"author"', '"author_link"', '"author_image"'):
        assert field not in text


# --- Groq summaries for this real product, replayed from fixtures/llm/summary/ ---


@pytest.mark.parametrize("name", ["overview", "specs", "reviews"])
def test_recorded_groq_summaries_are_grounded(iphone, name):
    import asyncio

    from app.brain.grounding import check
    from app.brain.llm_sections import llm_section

    result = asyncio.run(llm_section(name, iphone))
    assert check(result.output, {iphone.id: iphone}, result.derived).dropped == []
    assert result.output.summary.endswith(".")


def test_recorded_reviews_keep_mixed_topics(iphone):
    import asyncio

    from app.brain.llm_sections import llm_section

    out = asyncio.run(llm_section("reviews", iphone)).output
    texts = " ".join(i.text for s in out.sections for i in s.items)
    for topic in ("Appearance", "Battery life", "Camera quality", "Heat"):
        assert topic in texts
    assert "2764 reviews" not in out.summary


# --- real-data fixes: long specs, spec count, listing-error warning, variants ---


@pytest.mark.parametrize("path", ["llm", "template"])
def test_specs_are_short_capped_and_warn(iphone, path):
    import asyncio

    from app.brain import sections
    from app.brain.llm_sections import MAX_ITEM_CHARS, llm_section

    build = llm_section("specs", iphone) if path == "llm" else sections.specs(iphone)
    out = asyncio.run(build).output
    specs = [i for s in out.sections for i in s.items if i.kind.value == "spec"]
    assert len(specs) == sections.MAX_SPEC_ITEMS
    assert all(len(i.text) <= MAX_ITEM_CHARS + 20 for i in specs), [i.text for i in specs]
    assert any("IP68" in i.text for i in specs)
    assert out.warnings == [
        "The page lists the same size, 128 GB, for RAM and for storage. "
        "One of them may be a listing error."
    ]


def test_variant_item_cites_every_option(iphone):
    import asyncio

    from app.brain.llm_sections import llm_section

    out = asyncio.run(llm_section("overview", iphone)).output
    item = next(i for s in out.sections for i in s.items if i.text.startswith("Colour:"))
    assert item.text == "Colour: Black (selected), Pink, Teal, Ultramarine, White"
    cited = {g.field_path for g in out.grounding}
    assert {f"variants[{i}].value" for i in range(5)} <= cited
