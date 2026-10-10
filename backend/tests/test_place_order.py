"""Place order (rule 2): summary read aloud, one high-risk confirmation, press only after yes."""

import asyncio
import json

import pytest

from app.brain import session, tools
from app.brain.grounding import check
from app.models import CheckoutSummary, TurnRequest


@pytest.fixture(autouse=True)
def fresh():
    session.reset()


@pytest.fixture
def checkout(mock_body):
    return mock_body("PageContext.checkout")


@pytest.fixture
def ctx(mock_body):
    def make(page, sid="s", pay="upi"):
        data = mock_body("TurnRequest")
        data["session_id"] = sid
        data["page"] = page
        data["prefs"]["preferred_payment"] = pay
        return tools.Context(TurnRequest.model_validate(data))

    return make


def run(coro):
    return asyncio.run(coro)


def test_summary_and_one_high_risk_confirmation(ctx, checkout):
    r = run(tools.order_task(ctx(checkout), task="place"))
    assert r.output.summary == "Place this order? Total ₹18,597. Delivery PIN 500032."
    assert r.actions == [], "the order is never placed directly"
    c = r.confirmation
    assert c["risk"] == "high"
    assert [a["target_id"] for a in c["pending_actions"]] == ["t-place-order"]
    assert c["read_back"] == {
        "quantity": 3,
        "total": {"amount": 18597, "currency": "INR"},
        "pin_code": "500032",
    }
    items = [i.text for i in r.output.sections[0].items]
    assert items[-1] == "Payment: cash on delivery"
    assert "Deliver to: ADDR_1" in items, "the address stays a placeholder"
    summary = CheckoutSummary.model_validate(checkout["checkout"])
    assert check(r.output, {summary.id: summary}, set(range(1, 10))).dropped == []
    assert r.workflow == {"name": "place_order", "step": 1, "total_steps": 2}


def test_warns_when_payment_differs_from_preference(ctx, checkout):
    r = run(tools.order_task(ctx(checkout, pay="upi"), task="place"))
    assert r.output.warnings == [
        "Your preferred payment is UPI, but this page shows cash on delivery."
    ]
    same = run(tools.order_task(ctx(checkout, sid="t", pay="cod"), task="place"))
    assert same.output.warnings == []


@pytest.mark.parametrize(
    ("change", "says"),
    [
        (lambda c: c["checkout"].update(total=None), "I can't read the order total"),
        (
            lambda c: c["checkout"].update(place_order_target_id=None),
            "I can't read the order total",
        ),
        (lambda c: c["checkout"].update(payment_method=None), "doesn't show a payment method"),
        (lambda c: c.update(checkout=None), "I can't read the order summary"),
    ],
)
def test_refuses_without_what_must_be_read_back(ctx, checkout, change, says):
    change(checkout)
    r = run(tools.order_task(ctx(checkout), task="place"))
    assert says in r.output.summary
    assert r.confirmation is None and r.actions == []


def test_not_on_checkout(ctx, mock_body):
    r = run(tools.order_task(ctx(mock_body("TurnRequest")["page"]), task="place"))
    assert r.output.summary.startswith("Open your cart and go to checkout first")


def test_verifies_the_order_page(ctx, checkout):
    run(tools.order_task(ctx(checkout), task="place"))
    after = json.loads(json.dumps(checkout))
    after.update(page_type="order_detail", checkout=None)
    after["orders"] = [
        {"schema_version": "1.0", "id": "ORDER_1",
         "items": [{"title": "Zentra Pulse 5G", "quantity": 1, "price": None, "product_url": None}],
         "status": "placed",
         "dates": {"ordered": "2026-10-11", "expected_delivery": None, "delivered": None},
         "available_actions": ["track", "cancel"]}
    ]  # fmt: skip
    r = run(tools.order_task(ctx(after)))
    assert r.output.summary == "Your order is placed."
    assert session.get("s").workflow is None


def test_pressing_place_order_directly_is_refused(ctx, checkout):
    r = run(tools.press(ctx(checkout), "t-place-order"))
    assert r.actions == [] and r.confirmation is None
    assert 'Say "place my order"' in r.output.summary


# --- through /turn with real Groq tool calls (recorded live 2026-10-11) ---


@pytest.mark.parametrize("text", ["place my order", "go ahead and order it"])
def test_spoken_place_order_reads_the_summary_first(mock_body, text):
    from app.brain import orchestrator

    data = mock_body("TurnRequest")
    data["page"] = mock_body("PageContext.checkout")
    data["prefs"]["lang"] = "en"
    data["history"] = []
    data["input"].update(
        kind="voice",
        text=text,
        lang="en",
        asr_meta={"confidence": None, "mic_level": 0.5, "alternatives": []},
    )
    r = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert r.intent.name == "order_task"
    assert r.actions == []
    assert r.confirmation.risk.value == "high"
    assert r.output.summary == "Place this order? Total ₹18,597. Delivery PIN 500032."
