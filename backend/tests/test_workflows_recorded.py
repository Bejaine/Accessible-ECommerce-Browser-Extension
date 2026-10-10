"""Order workflows through /turn with real Groq tool calls (recorded live 2026-10-11).

Track A's ASR sends no confidence (null) and no alternatives; the requests here do the same.
"""

import asyncio

import pytest

from app.brain import orchestrator, session
from app.models import TurnRequest


@pytest.fixture(autouse=True)
def fresh():
    session.reset()


def turn(mock_body, sid, text):
    data = mock_body("TurnRequest")
    data["session_id"] = sid
    data["history"] = []
    data["page"] = mock_body("PageContext.orders")
    data["prefs"]["lang"] = "en"
    data["input"].update(
        kind="voice",
        text=text,
        lang="en",
        asr_meta={"confidence": None, "mic_level": 0.5, "alternatives": []},
    )
    return asyncio.run(orchestrator.handle_turn(TurnRequest.model_validate(data)))


def test_where_is_my_order(mock_body):
    r = turn(mock_body, "o1", "where is my earphones order")
    assert r.workflow.name.value == "track_order"
    assert r.output.summary == (
        "Your order of Zentra Buds Air (White) has been shipped. Expected delivery: 12 October."
    )


def test_return_conversation_then_stop(mock_body):
    r1 = turn(mock_body, "o2", "I want to return the back cover")
    assert r1.output.summary.startswith("Why are you returning Silicone Back Cover")
    r2 = turn(mock_body, "o2", "it came broken")
    assert "Reason: it came broken;" in r2.output.summary
    assert r2.confirmation.risk.value == "high" and r2.actions == []
    assert r2.confirmation.pending_actions[0].target_id == "t-return-2"
    r3 = turn(mock_body, "o2", "actually never mind")
    assert r3.output.summary == "Stopped. I didn't change anything else."
    assert session.get("o2").workflow is None


def test_cancel_my_order(mock_body):
    r = turn(mock_body, "o3", "cancel my order")
    assert r.confirmation.risk.value == "high"
    assert r.confirmation.read_back.total.amount == 1999
    assert r.workflow.step == 2 and r.workflow.total_steps == 3
