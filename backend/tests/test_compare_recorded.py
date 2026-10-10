"""Comparison over a real conversation: Groq tool calls replayed from fixtures/llm/turn/.

Recorded live on 2026-10-11 (gpt-oss-120b / 20b). One session moves from the iPhone page
(preferences stated) to another product page (compare with the iPhone seen before).
"""

import asyncio
import json
from pathlib import Path

import pytest

from app.brain import orchestrator, session
from app.models import TurnRequest
from app.services.serpapi import to_product

REPO = Path(__file__).resolve().parents[2]


@pytest.fixture(autouse=True)
def fresh_sessions():
    session.reset()


def turn(mock_body, sid, text, *, page=None, product=None):
    data = mock_body("TurnRequest")
    data["session_id"] = sid
    data["history"] = []
    data["prefs"]["lang"] = "en"
    data["input"].update(
        kind="voice",
        text=text,
        lang="en",
        asr_meta={"confidence": 0.93, "mic_level": 0.5, "alternatives": []},
    )
    if page:
        data["page"] = mock_body(page)
    if product:
        data["page"]["products"] = [product]
        data["page"]["url"] = product["url"]
    return asyncio.run(orchestrator.handle_turn(TurnRequest.model_validate(data)))


def iphone() -> dict:
    raw = json.loads((REPO / "fixtures/serpapi/amazon_product.B0DGJHBX5Y.json").read_text())
    return to_product(raw)


def test_preferences_then_compare_with_a_product_seen_before(mock_body):
    a = turn(
        mock_body,
        "conv",
        "I mostly care about the camera, battery doesn't matter, my budget is 80000",
        product=iphone(),
    )
    assert a.intent.name == "set_preferences"
    remembered = session.get("conv")
    assert remembered.priorities == {"camera": 1.0, "battery": 0.0}
    assert remembered.max_price == 80000

    b = turn(mock_body, "conv", "compare this with the iPhone I saw earlier")
    assert b.intent.name == "compare"
    assert b.output.summary == (
        "For what you asked, Apple iPhone 16 128 GB comes first. It is the only one whose page "
        "lists the main camera: Advanced dual-camera system: 48MP Fusion: 26 mm."
    )
    table = b.output.sections[0].table
    assert table.columns == ["", "Apple iPhone 16 128 GB", "Zentra Pulse 5G"]
    assert table.rows[0] == [
        "Main camera",
        "Advanced dual-camera system: 48MP Fusion: 26 mm",
        "not listed",
    ]
    assert any("same size, 128 GB, for RAM and storage" in w for w in b.output.warnings)
    assert b.actions == [] and b.confirmation is None


def test_budget_leaves_one_product(mock_body):
    r = turn(mock_body, "c2", "which phone is best for me under 16000", page="PageContext.search")
    assert r.intent.name == "recommend"
    assert r.output.summary == "Only one fits: Orbita M3 5G, ₹13,999 and 3.9 out of 5."
    assert r.output.warnings == [
        "Sponsored listings were left out.",
        "1 more did not fit your budget or rating.",
    ]


def test_asking_for_a_feature_no_listing_shows(mock_body):
    r = turn(mock_body, "c3", "I want the one with the best battery", page="PageContext.search")
    assert r.output.summary.startswith(
        "None of these listings show the battery, so on price and rating, "
        "Zentra Pulse 5G comes first."
    )
