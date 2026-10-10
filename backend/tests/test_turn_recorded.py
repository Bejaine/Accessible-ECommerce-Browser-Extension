"""/turn end to end with real Groq tool calls, replayed from fixtures/llm/turn/ (MOCK=1).

Recorded live on 2026-10-10 with openai/gpt-oss-120b; see fixtures/llm/README.md to re-record.
"""

import asyncio

import pytest

from app.brain import orchestrator
from app.models import TurnRequest


@pytest.fixture(autouse=True)
def fresh_sessions(monkeypatch):
    monkeypatch.setattr(orchestrator, "_sessions", orchestrator.TTLCache(60))


def turn(mock_body, text, *, lang="en", alts=(), conf=0.9, page=None, session="s"):
    data = mock_body("TurnRequest")
    data["session_id"] = session
    data["input"].update(
        kind="voice",
        text=text,
        lang=lang,
        asr_meta={"confidence": conf, "mic_level": 0.5, "alternatives": list(alts)},
    )
    data["prefs"]["lang"] = lang
    data["history"] = []
    if page:
        data["page"] = mock_body(page)
    return asyncio.run(orchestrator.handle_turn(TurnRequest.model_validate(data)))


def test_reviews_question_reads_the_prepared_section(mock_body):
    r = turn(mock_body, "what do the reviews say")
    assert r.intent.name == "read_section" and r.intent.confidence >= 0.8
    assert r.output.summary.startswith("Customers mention battery life most")
    assert r.actions == [] and r.confirmation is None


def test_hinglish_add_to_cart_asks_to_confirm(mock_body):
    r = turn(
        mock_body, "isse cart mein daal do", lang="hi", alts=["ise kart mein dal do"], conf=0.82
    )
    assert r.intent.name == "add_to_cart"
    assert r.actions == [], "never act before the user confirms"
    assert [a.target_id for a in r.confirmation.pending_actions] == ["t-add-to-cart"]
    assert r.confirmation.read_back.total.amount == 17999
    # Translation isn't available yet (Track A), so the answer says it is English.
    assert r.output.lang.value == "en"


def test_quantity_is_read_back(mock_body):
    r = turn(mock_body, "add two of these to my cart")
    assert [(a.type.value, a.value) for a in r.confirmation.pending_actions] == [
        ("select", "2"),
        ("click", None),
    ]
    assert r.confirmation.read_back.quantity == 2
    assert "₹35,998" in r.output.summary


def test_question_is_answered_from_the_page(mock_body):
    r = turn(mock_body, "does it have a big battery")
    assert r.output.summary == "Battery Capacity: 5000 mAh."
    assert r.output.grounding[0].field_path == "specs.battery.value"


def test_choosing_a_colour_acts_directly(mock_body):
    r = turn(mock_body, "show me the green one")
    assert [(a.type.value, a.target_id) for a in r.actions] == [("click", "t-swatch-green")]


def test_buy_now_is_refused(mock_body):
    r = turn(mock_body, "buy it now")
    assert r.actions == [] and r.confirmation is None
    assert "won't press" in r.output.summary


def test_search_navigates(mock_body):
    r = turn(mock_body, "search for wireless earphones under 2000")
    assert r.actions[0].value == "https://www.amazon.in/s?k=wireless+earphones+under+2000"


def test_unclear_speech_asks_instead_of_acting(mock_body):
    """Dysarthria-like: low ASR confidence, several hearings. Confidence 0.6 -> ask, never act."""
    r = turn(mock_body, "a cart", alts=["a cart", "the cart", "add cart"], conf=0.41)
    assert 0.5 <= r.intent.confidence < 0.8
    assert r.actions == [] and r.confirmation is None
    assert r.output.summary.startswith("Did you mean")


def test_noise_offers_phrase_chips(mock_body):
    r = turn(mock_body, "mmm hmm uh", alts=["mm hmm", "um"], conf=0.2)
    assert r.intent.confidence < 0.5
    assert r.output.followups == ["Price", "Specs", "Reviews", "Add to cart"]


def test_two_misses_in_a_row_go_straight_to_chips(mock_body):
    turn(mock_body, "a cart", alts=["a cart", "the cart"], conf=0.41, session="same")
    r = turn(mock_body, "a cart", alts=["a cart", "the cart"], conf=0.41, session="same")
    assert not r.output.summary.startswith("Did you mean"), "never ask a third time"
    assert r.output.followups == ["Price", "Specs", "Reviews", "Add to cart"]


def test_cheapest_on_a_search_page(mock_body):
    r = turn(mock_body, "which one is the cheapest", page="PageContext.search")
    assert r.output.summary == "Best match by lowest price: Orbita M3 5G, ₹13,999, rated 3.9."


def test_compare_on_a_search_page(mock_body):
    r = turn(mock_body, "compare the first two", page="PageContext.search")
    rows = r.output.sections[0].table.rows
    assert rows[0] == ["Price", "₹15,499", "₹17,999"]


def test_specific_question_uses_answer_question_even_when_not_listed(mock_body):
    """Seen live: "warranty" read the whole overview, "weigh" came back "unclear"."""
    for text, topic in [
        ("tell me something about the warranty", "warranty"),
        ("how much does it weigh", "weight"),
    ]:
        r = turn(mock_body, text)
        assert r.intent.name == "answer_question"
        assert r.output.summary == f"The page doesn't list {topic}."


def test_low_confidence_transcript_never_acts(mock_body):
    """The recorded model answer for "a cart" is go_to_cart at 0.6-0.85; with ASR confidence
    0.41 the turn must ask, not open the cart."""
    r = turn(mock_body, "a cart", alts=["a cart", "the cart", "add cart"], conf=0.41)
    assert r.intent.confidence < 0.8 and r.actions == []


def test_photo_request_falls_back_to_the_label_when_it_cannot_be_described(mock_body):
    r = turn(mock_body, "describe the main photo")
    assert r.intent.name == "describe_photo"
    assert r.output.summary.endswith(
        "Its label says: Zentra Pulse 5G front and back, Midnight Black."
    )
