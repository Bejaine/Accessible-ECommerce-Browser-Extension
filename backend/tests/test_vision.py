"""Photo descriptions (Gemini), replayed from fixtures/llm/vision/ (recorded live 2026-10-11)."""

import asyncio
import json
from pathlib import Path

import pytest

from app.brain import prepare, tools, vision
from app.brain.grounding import check
from app.brain.llm import LLMError
from app.models import ProductJSON, TurnRequest
from app.services.serpapi import to_product

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setattr(vision, "_cache", vision.TTLCache(60))
    monkeypatch.setattr(prepare, "_cache", prepare.TTLCache(60))


@pytest.fixture
def iphone() -> ProductJSON:
    raw = json.loads((REPO / "fixtures/serpapi/amazon_product.B0DGJHBX5Y.json").read_text())
    return ProductJSON.model_validate(to_product(raw))


def run(coro):
    return asyncio.run(coro)


# --- what the VLM says is checked against the page ---


def test_numbers_and_printed_text_need_confirmation():
    answer = {
        "is_product_photo": True,
        "description": "A black phone with three cameras. It has a 6000 mAh battery.",
        "colours": ["black"],
        "items_shown": ["phone"],
        "visible_text": ["Nova 2", "Massive 6000mAh All-Day Battery", "IP67 Rating"],
        "unclear": ["ports"],
    }
    d = vision.verify(answer, "u", evidence="Ai+ Nova 2 5G (Black, 64 GB)")
    assert d.description == "A black phone with three cameras."
    assert d.visible_text == ["Nova 2"]
    assert len(d.dropped) == 3


def test_ocr_text_confirms_printed_text():
    answer = {
        "is_product_photo": True,
        "description": "A box with a 33W charger.",
        "colours": [],
        "items_shown": ["box", "charger"],
        "visible_text": ["33W"],
        "unclear": [],
    }
    d = vision.verify(answer, "u", evidence="Handset, 33W charger, USB-C cable")
    assert d.description == "A box with a 33W charger."
    assert d.visible_text == ["33W"]


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://m.media-amazon.com/images/I/61135j8fPJL._SL1500_.jpg", True),
        ("https://rukmini1.flixcart.com/image/1500/1500/x.jpeg", True),
        ("http://m.media-amazon.com/images/I/x.jpg", False),  # not https
        ("https://evil.example/m.media-amazon.com.jpg", False),
        ("https://169.254.169.254/latest/meta-data", False),  # no fetching internal addresses
        ("https://media-amazon.com.evil.net/x.jpg", False),
    ],
)
def test_only_shop_image_hosts_are_downloaded(url, ok):
    assert vision._host_ok(url) is ok


def test_recorded_real_photo(iphone):
    d = run(vision.describe_url(iphone.images[0].url, iphone))
    assert d.description.startswith("Two identical black smartphones")
    assert d.dropped == []


# --- in /product/prepare and /turn ---


def test_images_section_uses_the_description_and_is_grounded(iphone):
    result = run(prepare.images_with_vlm(iphone))
    out = result.output
    assert "Two identical black smartphones" in out.sections[0].items[0].text
    assert out.warnings == [vision.AI_NOTE]
    enriched = vision.with_descriptions(iphone)
    assert check(out, {iphone.id: enriched}, result.derived).dropped == []


def test_images_section_falls_back_without_vlm(iphone, monkeypatch):
    async def down(*_a, **_k):
        raise LLMError("gemini down")

    monkeypatch.setattr(vision, "_ask_vlm", down)
    out = run(prepare.images_with_vlm(iphone)).output
    assert out.warnings == []
    assert out.summary.startswith("There are 6 product photos.")


def test_prepare_returns_product_with_descriptions(iphone):
    from app.models import ProductPrepareRequest

    req = ProductPrepareRequest.model_validate(
        {
            "schema_version": "1.0",
            "product": iphone,
            "prefs": {
                "lang": "en",
                "tts_rate": 1.0,
                "text_scale": 1.0,
                "verbosity": "normal",
                "lite_mode": False,
                "text_first": False,
                "switch_key": "Space",
                "preferred_payment": None,
            },
        }
    )
    res = run(prepare.prepare(req))
    assert res.product.images[0].description.startswith("Two identical black smartphones")
    assert res.sections.images is not None


def test_describe_photo_tool(iphone, mock_body):
    data = mock_body("TurnRequest")
    data["page"]["products"] = [iphone.model_dump(mode="json", by_alias=True)]
    ctx = tools.Context(TurnRequest.model_validate(data))
    result = run(tools.describe_photo(ctx, 1))
    assert result.output.summary.startswith("Two identical black smartphones")
    assert result.output.warnings == [vision.AI_NOTE]
    assert result.output.followups[0] == "Describe the next photo"


def test_vision_route_without_recording_serves_the_mock(client, assert_schema, mock_body):
    res = client.post("/vision/describe", json=mock_body("VisionDescribeRequest"))
    assert res.status_code == 200
    assert_schema("VisionDescribeResponse", res.json())


def test_vision_route_real_recording(client, assert_schema):
    url = "https://m.media-amazon.com/images/I/512jrg8-68L._SL1500_.jpg"
    res = client.post(
        "/vision/describe", json={"schema_version": "1.0", "image_url": url, "lang": "en"}
    )
    assert res.status_code == 200
    body = res.json()
    assert_schema("VisionDescribeResponse", body)
    assert body["output"]["summary"].startswith("A black wireless charging case")
    assert body["output"]["warnings"] == [vision.AI_NOTE]
