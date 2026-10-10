"""/turn tools and the paths that need no LLM: safety rules first."""

import asyncio
import json

import pytest

from app.brain import orchestrator, session, tools
from app.brain.grounding import check
from app.errors import ApiError
from app.models import TurnRequest


@pytest.fixture
def req(mock_body) -> TurnRequest:
    return TurnRequest.model_validate(mock_body("TurnRequest"))


@pytest.fixture
def search_req(mock_body) -> TurnRequest:
    data = mock_body("TurnRequest")
    data["page"] = mock_body("PageContext.search")
    return TurnRequest.model_validate(data)


def run(coro):
    return asyncio.run(coro)


def with_input(req: TurnRequest, **changes) -> TurnRequest:
    data = req.model_dump(mode="json", by_alias=True)
    data["input"].update(changes)
    return TurnRequest.model_validate(data)


# --- consequential actions only through a Confirmation ---


def test_add_to_cart_is_a_confirmation_with_read_back(req):
    ctx = tools.Context(req)
    result = run(tools.add_to_cart(ctx, quantity=2))
    assert result.actions == []
    conf = result.confirmation
    assert [(a["type"], a["target_id"], a["value"]) for a in conf["pending_actions"]] == [
        ("select", "t-qty", "2"),
        ("click", "t-add-to-cart", None),
    ]
    assert conf["read_back"] == {
        "quantity": 2,
        "total": {"amount": 35998.0, "currency": "INR"},
        "pin_code": None,
    }
    assert result.output.summary == (
        "Add Zentra Pulse 5G, Midnight Black, quantity 2, for ₹35,998, to your cart?"
    )
    assert conf["pending_actions"][-1]["expected_effect"]["kind"] == "cart_count_increase"


@pytest.mark.parametrize("label", ["Buy Now", "Place your order", "Pay ₹17,999"])
def test_buy_and_pay_buttons_are_never_pressed(req, label):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["targets"][-2]["label"] = label  # t-buy-now
    target = data["page"]["targets"][-2]["id"]
    ctx = tools.Context(TurnRequest.model_validate(data))
    result = run(tools.press(ctx, target))
    assert result.actions == [] and result.confirmation is None
    assert "won't press" in result.output.summary


def test_turn_never_lists_pending_actions_as_actions(req):
    response = run(
        orchestrator.handle_turn(with_input(req, kind="switch", target_id="t-add-to-cart"))
    )
    assert response.actions == []
    assert response.confirmation is not None
    assert response.confirmation.pending_actions[0].target_id == "t-add-to-cart"


def test_risky_buttons_need_high_risk_confirmation(req):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["targets"][-2]["label"] = "Cancel items"
    ctx = tools.Context(TurnRequest.model_validate(data))
    result = run(tools.press(ctx, data["page"]["targets"][-2]["id"]))
    assert result.confirmation["risk"] == "high"
    assert result.actions == []


# --- safe actions run directly ---


def test_choosing_a_colour_is_a_direct_action(req):
    result = run(tools.press(tools.Context(req), "t-swatch-green"))
    assert [(a["type"], a["target_id"]) for a in result.actions] == [("click", "t-swatch-green")]
    assert result.actions[0]["expected_effect"]["kind"] == "value_set"
    assert result.confirmation is None


def test_search_navigates_to_the_site_search(req):
    result = run(tools.search(tools.Context(req), "wireless earphones"))
    assert result.actions[0]["type"] == "navigate"
    assert result.actions[0]["value"] == "https://www.amazon.in/s?k=wireless+earphones"


def test_unknown_target_is_rejected(req):
    with pytest.raises(tools.ToolInputError):
        run(tools.press(tools.Context(req), "t-does-not-exist"))


# --- answers come from fields ---


def test_answer_question_finds_spec_by_topic(req):
    ctx = tools.Context(req)
    result = run(tools.answer_question(ctx, "battery capacity", field_paths=["specs.batery"]))
    assert result.output.summary == "Battery Capacity: 5000 mAh."
    p = ctx.main_product()
    assert check(result.output, {p.id: p}).dropped == []


def test_answer_question_says_when_page_does_not_list_it(req):
    result = run(tools.answer_question(tools.Context(req), "water resistance rating"))
    assert result.output.summary == "The page doesn't list water resistance rating."


def test_recommend_cheapest_skips_sponsored(search_req):
    session.reset()
    ctx = tools.Context(search_req)
    result = run(tools.recommend(ctx, prefer="cheapest"))
    table = result.output.sections[0].table
    assert table.columns == ["", "Orbita M3 5G", "Zentra Pulse 5G"]
    assert table.rows[0] == ["Price", "₹13,999", "₹17,999"]
    assert "Novix" not in json.dumps(table.model_dump()), "the sponsored listing is left out"
    assert result.output.warnings == ["Sponsored listings were left out."]


def test_compare_builds_a_grounded_table(search_req):
    ctx = tools.Context(search_req)
    ids = [p.id for p in search_req.page.products[:2]]
    result = run(tools.compare(ctx, ids))
    table = result.output.sections[0].table
    assert table.columns == ["", "Novix A15 5G", "Zentra Pulse 5G"]
    assert table.rows[0] == ["Price", "₹15,499", "₹17,999"]
    assert "not listed" not in json.dumps(table.rows)


def test_where_am_i(search_req):
    result = run(tools.where_am_i(tools.Context(search_req)))
    assert result.output.summary == "This is a search page on amazon.in. It lists 3 products."


# --- turn paths without an LLM ---


def test_secure_zone_stops_everything(req):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["secure_zone_active"] = True
    with pytest.raises(ApiError) as err:
        run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert err.value.code.value == "secure_zone"


def test_phrase_chip_runs_without_llm(req, monkeypatch):
    async def no_llm(*_a, **_k):
        raise AssertionError("chips must not call the LLM")

    monkeypatch.setattr(orchestrator, "complete_tool_call", no_llm)
    response = run(
        orchestrator.handle_turn(with_input(req, kind="phrase", text="Price", phrase_id=None))
    )
    assert response.output.summary == "Price: ₹17,999."
    assert response.intent.confidence == 1.0


def test_page_brief_is_small_and_has_no_page_text(req):
    brief = orchestrator.page_brief(req)
    assert set(brief) == {
        "page_type", "site", "products", "orders", "targets", "SEEN", "stated_preferences",
    }  # fmt: skip
    assert "reviews" not in json.dumps(brief)
