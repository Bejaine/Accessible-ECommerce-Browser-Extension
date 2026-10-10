"""Order workflows as step machines: track, cancel, return (docs/product.md).

extract -> ask -> act -> verify, with a step limit and confirmations; the LLM only fills slots
(which order, the return reason, stop). State lives in the session (TurnResponse.workflow says
where we are). Every fact about an order is grounded in its OrderJSON. Cancelling and returning
are only ever pending actions inside a high-risk Confirmation; the backend never acts.

Steps:  track  1 choose order -> 2 read status
        cancel 1 choose order -> 2 confirm -> 3 verify on the next page
        return 1 choose order -> 2 reason -> 3 confirm -> 4 verify on the next page
Place order is not here yet: it needs the checkout total and delivery PIN code read back,
and the page contracts don't carry a checkout summary (see docs/STATUS.md).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.brain import session
from app.brain.format import money
from app.brain.output import OutputBuilder, plain_output
from app.models import SCHEMA_VERSION, OrderJSON

MAX_TURNS = 8
MAX_CHOICES = 3

TASKS = {
    "track": {"name": "track_order", "action": "track", "verb": "track", "steps": 2},
    "cancel": {"name": "cancel_order", "action": "cancel", "verb": "cancel", "steps": 3},
    "return": {"name": "return_order", "action": "return", "verb": "return", "steps": 4},
}
BUTTONS = {
    "track": re.compile(r"\btrack\b", re.I),
    "cancel": re.compile(r"\bcancel\b", re.I),
    "return": re.compile(r"\b(return|replace)\b", re.I),
}
# Buttons on the follow-up page that finish a cancellation/return.
FINISH = re.compile(
    r"(confirm|submit|request)\s+(cancel|return)|cancel (checked )?items|"
    r"(confirm|submit) (your )?(request|return)|\bcontinue\b",
    re.I,
)
ORDERS_URLS = {
    "amazon.in": "https://www.amazon.in/gp/your-account/order-history",
    "flipkart.com": "https://www.flipkart.com/account/orders",
}
STATUS_WORDS = {
    "placed": "has been placed",
    "shipped": "has been shipped",
    "out_for_delivery": "is out for delivery",
    "delivered": "was delivered",
    "cancelled": "is cancelled",
    "returned": "has been returned",
}
REASON_EXAMPLES = "For example: it arrived damaged, wrong item, or not as described."


@dataclass
class Result:
    output: Any  # AccessibleOutput
    actions: list[dict[str, Any]] = field(default_factory=list)
    confirmation: dict[str, Any] | None = None
    workflow: dict[str, Any] | None = None  # TurnResponse.workflow
    label: str = "Order help"
    dropped: list[str] = field(default_factory=list)


def _spoken_date(iso: date | None) -> str | None:
    return f"{iso.day} {iso.strftime('%B')}" if iso else None


def _first_item(o: OrderJSON) -> str:
    title = o.items[0].title if o.items else "this order"
    more = len(o.items) - 1
    return f"{title} and {more} more item{'s' if more > 1 else ''}" if more > 0 else title


def _state_marker(task: str, step: int) -> dict[str, Any]:
    return {"name": TASKS[task]["name"], "step": step, "total_steps": TASKS[task]["steps"]}


def _target_for(ctx, order: OrderJSON, task: str, orders: list[OrderJSON]):
    """The page's button for this action on this order. Several orders → match the order's
    position number in the target id (t-cancel-1 ↔ ORDER_1); otherwise ask to open the order."""
    candidates = [
        t
        for t in ctx.page.targets
        if BUTTONS[task].search(t.label) and not (t.state and t.state.disabled)
    ]
    eligible = [o for o in orders if TASKS[task]["action"] in o.available_actions]
    if len(candidates) == 1 and len(eligible) == 1:
        return candidates[0]
    number = order.id.split("_")[1]
    matches = [t for t in candidates if re.search(rf"(^|\D){number}$", t.id)]
    return matches[0] if len(matches) == 1 else None


def _say_status(order: OrderJSON) -> tuple[str, OutputBuilder]:
    b = OutputBuilder(order.id)
    what = _first_item(order)
    if order.items:
        b.ground(order.items[0].title, "items[0].title")
    status = order.status.value
    if status in STATUS_WORDS:
        b.ground(status.replace("_", " "), "status")
        text = f"Your order of {what} {STATUS_WORDS[status]}"
        if status == "delivered" and order.dates.delivered:
            when = _spoken_date(order.dates.delivered)
            b.ground(when, "dates.delivered")
            text += f" on {when}"
        text += "."
        if status in ("placed", "shipped", "out_for_delivery") and order.dates.expected_delivery:
            when = _spoken_date(order.dates.expected_delivery)
            b.ground(when, "dates.expected_delivery")
            text += f" Expected delivery: {when}."
    else:
        text = f"The page doesn't show the status of your order of {what}."
    return text, b


def _amount(order: OrderJSON) -> tuple[str, tuple[float, str] | None, int | None]:
    """What the user hears about quantity and price, and the read-back numbers (one item only:
    the page's price is read as written, never added up)."""
    if len(order.items) != 1:
        return "", None, None
    item = order.items[0]
    parts = [f"quantity {item.quantity}"]
    total = None
    if item.price is not None:
        listed = money(item.price.amount, item.price.currency)
        if item.quantity == 1:
            parts.append(f"price {listed}")
            total = (item.price.amount, item.price.currency)
        else:
            # The page doesn't say if this is per item or for all of them: don't call it a total.
            parts.append(f"price {listed} as listed")
    return ", ".join(parts), total, item.quantity


def _confirmation(ctx, prompt: str, actions, quantity, total) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "id": f"conf-{ctx._seq}",
        "prompt": prompt,
        "risk": "high",
        "pending_actions": actions,
        "read_back": {
            "quantity": quantity,
            "total": {"amount": total[0], "currency": total[1]} if total else None,
            "pin_code": None,
        }
        if quantity or total
        else None,
    }


async def advance(
    ctx,
    task: str | None = None,
    order_id: str | None = None,
    reason: str | None = None,
    stop: bool = False,
) -> Result:
    s = session.get(ctx.req.session_id)
    state = s.workflow

    if stop:
        s.workflow = None
        return Result(plain_output("Stopped. I didn't change anything else.", followups=["Help"]))
    if task and task in TASKS and (state is None or state["task"] != task):
        state = {
            "task": task,
            "step": 1,
            "order_id": None,
            "reason": None,
            "turns": 0,
            "awaiting": "order",
        }
    if state is None:
        out = plain_output(
            "I can track, cancel or return an order. Which one?",
            followups=["Track my order", "Cancel an order", "Return an order"],
        )
        return Result(out)

    state["turns"] += 1
    s.workflow = state
    if state["turns"] > MAX_TURNS:
        s.workflow = None
        return Result(
            plain_output("This is taking too long, so I stopped. Nothing more was changed.")
        )
    if reason:
        reason = reason.strip().rstrip(".")[:120]
        # "It came broken" -> "...because it came broken" (keep acronyms like "USB" as they are)
        if len(reason) > 1 and reason[1].islower():
            reason = reason[0].lower() + reason[1:]
        state["reason"] = reason
    task = state["task"]
    verb = TASKS[task]["verb"]

    orders = list(ctx.page.orders)
    if state["awaiting"] == "verify":
        return _verify(ctx, state, orders)
    if not orders:
        url = ORDERS_URLS.get(ctx.page.site)
        actions = (
            [ctx.action("navigate", None, url, "url_change", "Your orders page opens")]
            if url
            else []
        )
        say = (
            "Opening your orders. Tell me when it has loaded."
            if url
            else "Please open your orders page first."
        )
        return Result(plain_output(say, followups=["Continue", "Stop"]), actions=actions,
                      workflow=_state_marker(task, 1))  # fmt: skip

    eligible = [o for o in orders if TASKS[task]["action"] in o.available_actions]
    chosen = next((o for o in eligible if o.id == (order_id or state["order_id"])), None)
    if chosen is None and len(eligible) == 1:
        chosen = eligible[0]
    if not eligible:
        s.workflow = None
        b = OutputBuilder()
        return Result(
            b.checked({}, f"None of the orders on this page can be {verb}ed here.").output
        )
    if chosen is None:
        b = OutputBuilder()
        options = []
        for i, o in enumerate(eligible[:MAX_CHOICES], 1):
            b.derive(i)
            if o.items:
                b.ground(o.items[0].title, "items[0].title", o.id)
            options.append(f"{i}: {_first_item(o)}")
        more = (
            f" There are {len(eligible) - MAX_CHOICES} more." if len(eligible) > MAX_CHOICES else ""
        )
        if more:
            b.derive(len(eligible) - MAX_CHOICES)
        result = b.checked(
            {o.id: o for o in orders},
            f"Which order do you want to {verb}? {'; '.join(options)}.{more}",
            followups=[_first_item(o) for o in eligible[:MAX_CHOICES]] + ["Stop"],
        )
        state["awaiting"] = "order"
        return Result(result.output, workflow=_state_marker(task, 1), dropped=result.dropped)
    state["order_id"] = chosen.id

    if task == "track":
        s.workflow = None
        text, b = _say_status(chosen)
        on_the_way = chosen.status.value in ("placed", "shipped", "out_for_delivery")
        nxt = ["Open the tracking page", "Help"] if on_the_way else ["Return an order", "Help"]
        result = b.checked({chosen.id: chosen}, text, followups=nxt)
        return Result(result.output, workflow=_state_marker("track", 2), label="Track order",
                      dropped=result.dropped)  # fmt: skip

    if task == "return" and not state["reason"]:
        state["awaiting"] = "reason"
        b = OutputBuilder(chosen.id)
        if chosen.items:
            b.ground(chosen.items[0].title, "items[0].title")
        out = b.checked(
            {chosen.id: chosen},
            f"Why are you returning {_first_item(chosen)}? {REASON_EXAMPLES}",
            followups=["It arrived damaged", "Wrong item", "Not as described", "Stop"],
        ).output
        return Result(out, workflow=_state_marker("return", 2), label="Return order")

    target = _target_for(ctx, chosen, task, orders)
    if target is None:
        s.workflow = None
        say = (
            f"I can't tell which {verb} button belongs to this order. Open the order's own page, "
            "then ask me again."
        )
        return Result(plain_output(say, followups=["Help"]), workflow=_state_marker(task, 1))
    b = OutputBuilder(chosen.id)
    if chosen.items:
        b.ground(chosen.items[0].title, "items[0].title")
    amount, total, quantity = _amount(chosen)
    if chosen.items and chosen.items[0].price is not None:
        b.ground(
            money(chosen.items[0].price.amount, chosen.items[0].price.currency),
            "items[0].price.amount",
        )
    if quantity:
        b.derive(quantity)
    # Two short sentences, at most one name or price each (they translate cleanly).
    details = []
    if task == "return" and state["reason"]:
        details.append(f"reason: {state['reason']}")
    if amount:
        details.append(amount)
    if task == "cancel":
        details.append("this can't be undone")
    prompt = f"{verb.capitalize()} your order of {_first_item(chosen)}?"
    if details:
        said = "; ".join(details)
        prompt += f" {said[0].upper()}{said[1:]}."
    result = b.checked({chosen.id: chosen}, prompt, followups=["Yes", "No"])
    action = ctx.action("click", target.id, None, "url_change", f"The {verb} page opens")
    state["awaiting"] = "verify"
    step = 2 if task == "cancel" else 3
    return Result(
        result.output,
        confirmation=_confirmation(ctx, result.output.summary, [action], quantity, total),
        workflow=_state_marker(task, step),
        label=f"{verb.capitalize()} order",
        dropped=result.dropped,
    )


def _verify(ctx, state: dict[str, Any], orders: list[OrderJSON]) -> Result:
    """After the user confirmed and the extension pressed the button: read the page."""
    s = session.get(ctx.req.session_id)
    task, verb = state["task"], TASKS[state["task"]]["verb"]
    step = TASKS[task]["steps"]
    done = {"cancel": "cancelled", "return": "returned"}[task]
    order = next((o for o in orders if o.id == state["order_id"]), None)
    if order is not None and order.status.value == done:
        s.workflow = None
        b = OutputBuilder(order.id)
        b.ground(done, "status")
        out = b.checked(
            {order.id: order},
            f"Done: the page now shows this order as {done}.",
            followups=["Track my order", "Help"],
        ).output
        return Result(out, workflow=_state_marker(task, step), label=f"{verb.capitalize()} order")
    finish = next(
        (
            t
            for t in ctx.page.targets
            if FINISH.search(t.label) and not (t.state and t.state.disabled)
        ),
        None,
    )
    if finish is not None:
        prompt = f'To finish, press "{finish.label}"?'
        if task == "return" and state["reason"]:
            prompt += f" Choose the reason on this page: {state['reason']}."
        action = ctx.action(
            "click", finish.id, None, "url_change", f"{verb.capitalize()} request sent"
        )
        return Result(
            plain_output(prompt, followups=["Yes", "No"]),
            confirmation=_confirmation(ctx, prompt, [action], None, None),
            workflow=_state_marker(task, step),
            label=f"Finish the {verb}",
        )
    return Result(
        plain_output(
            f"I can't see the {verb} on this page yet. Check the screen, or say stop.",
            followups=["Where am I?", "Stop"],
        ),
        workflow=_state_marker(task, step),
    )
