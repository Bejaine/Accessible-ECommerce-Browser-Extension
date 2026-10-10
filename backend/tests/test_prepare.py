import asyncio

import pytest

from app.brain import prepare as prepare_mod
from app.brain import review_summariser, sections
from app.brain.grounding import check
from app.models import ProductJSON, ProductPrepareRequest

PID = "amazon.in:B0ZNTRA5G1"


@pytest.fixture
def product(mock_body) -> ProductJSON:
    return ProductJSON.model_validate(mock_body("ProductJSON"))


def bare(product: ProductJSON) -> ProductJSON:
    """The same product with every optional field missing, as a weak page would give it."""
    data = product.model_dump(mode="json", by_alias=True)
    for key in ("price", "rating", "availability", "delivery", "reviews", "seller", "variants"):
        data[key] = None
    data.update(specs={}, images=[], missing=["price", "rating", "specs", "reviews", "delivery"])
    return ProductJSON.model_validate(data)


def run(coro):
    return asyncio.run(coro)


def assert_grounded(product, result):
    """Every builder output is already checked: re-checking drops nothing."""
    assert result.dropped == []
    again = check(result.output, {product.id: product}, result.derived)
    assert again.dropped == []
    for section in result.output.sections:
        for item in section.items:
            if item.grounding_index is not None:
                assert item.grounding_index < len(result.output.grounding)


def test_overview(product):
    result = run(sections.overview(product))
    assert_grounded(product, result)
    out = result.output
    assert out.summary == (
        "Zentra Pulse 5G costs ₹17,999, down from ₹24,999. "
        "It is rated 4.2 out of 5 from 3,418 ratings."
    )
    texts = [i.text for i in out.sections[0].items]
    assert "FREE delivery Tuesday, 14 October" in texts
    assert out.lang.value == "en"


def test_specs(product):
    result = run(sections.specs(product))
    assert_grounded(product, result)
    items = result.output.sections[0].items
    assert items[0].text == "Battery Capacity: 5000 mAh"
    assert {i.kind.value for i in items} == {"spec"}
    assert len(items) == len(product.specs)


def test_reviews(product):
    result = run(review_summariser.summarise_product(product))
    assert_grounded(product, result)
    out = result.output
    # Insight counts come from the shop's own summary, so no "based on N reviews".
    assert out.summary.startswith("In the shop's review summary, people like the battery life")
    assert "690" not in out.summary
    headings = [s.heading for s in out.sections]
    assert headings[:2] == ["Pros", "Cons"]
    assert "Star ratings" in headings
    cons = out.sections[1].items
    assert cons[0].text == "Low-light camera: 68 of 96 mentions are negative"


def test_images(product):
    result = run(sections.images(product))
    assert_grounded(product, result)
    texts = [i.text for i in result.output.sections[0].items]
    assert texts[-1].startswith("Text on photo 2: Handset, 33W charger")


@pytest.mark.parametrize(
    ("builder", "phrase"),
    [
        (sections.overview, "doesn't list the price"),
        (sections.specs, "doesn't list any specs"),
        (review_summariser.summarise_product, "doesn't show any reviews"),
        (sections.images, "doesn't show any product photos"),
    ],
)
def test_missing_fields_are_said_not_guessed(product, builder, phrase):
    weak = bare(product)
    result = run(builder(weak))
    assert phrase in result.output.summary
    assert_grounded(weak, result)


def test_prepare_runs_all_sections_and_caches(product, monkeypatch):
    calls = []
    real = dict(prepare_mod.BUILDERS)

    def counting(name):
        async def wrapped(p):
            calls.append(name)
            return await real[name](p)

        return wrapped

    monkeypatch.setattr(prepare_mod, "BUILDERS", {n: counting(n) for n in real})
    monkeypatch.setattr(prepare_mod, "_cache", prepare_mod.TTLCache(60))
    req = ProductPrepareRequest.model_validate(
        {"schema_version": "1.0", "product": product, "prefs": _prefs()}
    )
    first = run(prepare_mod.prepare(req))
    second = run(prepare_mod.prepare(req))
    assert sorted(calls) == ["images", "overview", "reviews", "specs"]
    assert first == second
    assert first.sections.comparison is None

    cheaper = product.model_copy(deep=True)
    cheaper.price.amount = 16999
    req2 = req.model_copy(update={"product": cheaper})
    third = run(prepare_mod.prepare(req2))
    assert len(calls) == 8, "a changed price must not be served from the cache"
    assert "₹16,999" in third.sections.overview.summary


def test_broken_section_becomes_null(product, monkeypatch):
    async def boom(_p):
        raise RuntimeError("vlm down")

    monkeypatch.setattr(prepare_mod, "BUILDERS", {**prepare_mod.BUILDERS, "images": boom})
    monkeypatch.setattr(prepare_mod, "_cache", prepare_mod.TTLCache(60))
    sections_ = run(prepare_mod.prepare_sections(product))
    assert sections_["images"] is None
    assert sections_["overview"] is not None


def test_prepare_route(client, assert_schema, mock_body):
    res = client.post("/product/prepare", json=mock_body("ProductPrepareRequest"))
    assert res.status_code == 200, res.text
    body = res.json()
    assert_schema("ProductPrepareResponse", body)
    assert body["product_id"] == PID
    assert body["sections"]["specs"]["sections"][0]["heading"] == "Specs"


def test_prepare_route_matches_mock_fixture(client, mock_body):
    """fixtures/mocks/ProductPrepareResponse.json is exactly what the backend returns, so the
    extension's in-browser mock and the real backend agree."""
    res = client.post("/product/prepare", json=mock_body("ProductPrepareRequest"))
    assert res.json() == mock_body("ProductPrepareResponse")


def test_reviews_route(client, assert_schema, mock_body):
    res = client.post("/reviews/summarize", json=mock_body("ReviewsSummarizeRequest"))
    assert res.status_code == 200, res.text
    assert_schema("AccessibleOutput", res.json())
    assert res.json()["grounding"]


def _prefs():
    return {
        "lang": "en",
        "tts_rate": 1.0,
        "text_scale": 1.0,
        "verbosity": "normal",
        "lite_mode": False,
        "text_first": False,
        "switch_key": "Space",
        "preferred_payment": None,
    }
