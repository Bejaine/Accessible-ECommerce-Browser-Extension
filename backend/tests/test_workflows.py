"""Order workflows (track, cancel, return) as step machines, on the orders page fixture."""

import asyncio
import json

import pytest

from app.brain import session, tools, workflows
from app.brain.grounding import check
from app.models import TurnRequest


@pytest.fixture(autouse=True)
def fresh():
    session.reset()


@pytest.fixture
def page(mock_body):
    return mock_body("PageContext.orders")


@pytest.fixture
def ctx(mock_body):
    def make(page, sid="s"):
        data = mock_body("TurnRequest")
        data["session_id"] = sid
        data["page"] = page
        return tools.Context(TurnRequest.model_validate(data))

    return make


def run(coro):
    return asyncio.run(coro)


def grounded(result, page):
    from app.models import OrderJSON

    orders = {o["id"]: OrderJSON.model_validate(o) for o in page["orders"]}
    assert check(result.output, orders, set(range(1, 10))).dropped == []


def test_track_reads_status_from_the_order(ctx, page):
    r = run(tools.order_task(ctx(page), task="track"))
    assert r.output.summary == (
        "Your order of Zentra Buds Air (White) has been shipped. Expected delivery: 12 October."
    )
    assert r.workflow == {"name": "track_order", "step": 2, "total_steps": 2}
    assert r.actions == [] and r.confirmation is None
    grounded(r, page)
    assert session.get("s").workflow is None, "a finished task is cleared"


def test_cancel_is_only_a_high_risk_confirmation_then_verified(ctx, page):
    r = run(tools.order_task(ctx(page), task="cancel"))
    assert r.actions == [], "never acts directly"
    assert r.confirmation["risk"] == "high"
    assert [a["target_id"] for a in r.confirmation["pending_actions"]] == ["t-cancel-1"]
    assert r.confirmation["read_back"]["total"] == {"amount": 1999, "currency": "INR"}
    assert r.output.summary == (
        "Cancel your order of Zentra Buds Air (White)? Quantity 1, price ₹1,999; "
        "this can't be undone."
    )
    grounded(r, page)

    form = json.loads(json.dumps(page))
    form["orders"] = []
    form["targets"] = [
        {"schema_version": "1.0", "id": "t-ok", "kind": "button", "label": "Cancel checked items",
         "zone": "orders", "state": None, "colour_name": None}
    ]  # fmt: skip
    r2 = run(tools.order_task(ctx(form)))
    assert r2.confirmation["risk"] == "high"
    assert [a["target_id"] for a in r2.confirmation["pending_actions"]] == ["t-ok"]

    done = json.loads(json.dumps(page))
    done["orders"][0]["status"] = "cancelled"
    r3 = run(tools.order_task(ctx(done)))
    assert r3.output.summary == "Done: the page now shows this order as cancelled."
    assert r3.workflow == {"name": "cancel_order", "step": 3, "total_steps": 3}
    assert session.get("s").workflow is None


def test_return_asks_why_then_confirms_without_calling_a_price_a_total(ctx, page):
    r = run(tools.order_task(ctx(page), task="return"))
    assert r.output.summary.startswith("Why are you returning Silicone Back Cover")
    assert r.workflow["step"] == 2
    r2 = run(tools.order_task(ctx(page), reason="it arrived damaged"))
    assert r2.output.summary == (
        "Return your order of Silicone Back Cover for Zentra Pulse 5G? Reason: it arrived "
        "damaged; quantity 2, price ₹598 as listed."
    )
    # quantity 2 at ₹598: per item or in total? The page doesn't say, so no total is read back.
    assert r2.confirmation["read_back"] == {"quantity": 2, "total": None, "pin_code": None}
    assert [a["target_id"] for a in r2.confirmation["pending_actions"]] == ["t-return-2"]


def test_asks_which_order_when_several_fit(ctx, page):
    page["orders"][1]["available_actions"] = ["track", "return"]
    r = run(tools.order_task(ctx(page), task="track"))
    assert r.output.summary == (
        "Which order do you want to track? 1: Zentra Buds Air (White); "
        "2: Silicone Back Cover for Zentra Pulse 5G."
    )
    r2 = run(tools.order_task(ctx(page), order_id="ORDER_2"))
    assert r2.output.summary.endswith("was delivered on 27 September.")
    assert r2.output.followups[0] == "Return an order"


def test_opens_the_orders_page_when_not_on_it(ctx, mock_body):
    r = run(tools.order_task(ctx(mock_body("TurnRequest")["page"]), task="track"))
    assert r.actions[0]["type"] == "navigate"
    assert r.actions[0]["value"] == "https://www.amazon.in/gp/your-account/order-history"


def test_stop_clears_the_task(ctx, page):
    run(tools.order_task(ctx(page), task="return"))
    r = run(tools.order_task(ctx(page), stop=True))
    assert r.output.summary == "Stopped. I didn't change anything else."
    assert session.get("s").workflow is None


def test_step_limit(ctx, page):
    run(tools.order_task(ctx(page), task="return"))
    for _ in range(workflows.MAX_TURNS):
        r = run(tools.order_task(ctx(page)))
    assert r.output.summary.startswith("This is taking too long")
    assert session.get("s").workflow is None


def test_no_matching_button_means_no_action(ctx, page):
    page["targets"] = [t for t in page["targets"] if t["id"] != "t-cancel-1"]
    r = run(tools.order_task(ctx(page), task="cancel"))
    assert r.confirmation is None and r.actions == []
    assert "Open the order's own page" in r.output.summary


def test_turn_response_carries_the_workflow(mock_body, monkeypatch):
    from app.brain import orchestrator

    async def tool_call(*_a, **_k):
        return "order_task", {"task": "track", "confidence": 0.95, "alternatives": []}

    monkeypatch.setattr(orchestrator, "complete_tool_call", tool_call)
    data = mock_body("TurnRequest")
    data["page"] = mock_body("PageContext.orders")
    data["input"].update(text="where is my order", lang="en")
    r = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert r.workflow.name.value == "track_order"
    assert r.workflow.step == 2


def test_continue_chip_moves_the_task_on_without_an_llm(mock_body, monkeypatch):
    from app.brain import orchestrator

    async def no_llm(*_a, **_k):
        raise AssertionError("chips never call the LLM")

    monkeypatch.setattr(orchestrator, "complete_tool_call", no_llm)
    page = mock_body("PageContext.orders")
    data = mock_body("TurnRequest")
    data["page"] = page
    data["input"].update(kind="phrase", text="Cancel an order", phrase_id=None, lang="en")
    first = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert first.confirmation is not None
    page["orders"][0]["status"] = "cancelled"
    data["input"].update(text="Continue")
    done = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert done.output.summary == "Done: the page now shows this order as cancelled."
