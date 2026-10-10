"""Plain functions the /turn LLM can call (function calling). No agent framework.

The LLM only chooses a tool and its arguments; every tool builds its answer from the page
(ProductJSON / ActionTarget) with grounding, and anything consequential comes back as a
Confirmation whose actions run only after the user says yes (rules 2 and 3).
"""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote_plus

from app.brain import compare as compare_mod
from app.brain import features, prepare, session, vision
from app.brain.format import brief, join_words, money, number, short_title, spec_value
from app.brain.grounding import Unresolved, resolve
from app.brain.llm import LLMError
from app.brain.output import OutputBuilder, plain_output
from app.models import SCHEMA_VERSION, AccessibleOutput, ActionTarget, ProductJSON, TurnRequest

# Target labels, by how much care they need.
BLOCKED = re.compile(r"place (your )?order|pay now|\bpay\b|complete (purchase|order)|buy now", re.I)
CART = re.compile(r"add to (cart|basket|bag)", re.I)
RISKY = re.compile(r"\b(cancel|return|replace|delete|remove)\b", re.I)
CHECKOUT = re.compile(r"proceed to (checkout|buy)|checkout", re.I)
QUANTITY = re.compile(r"\b(quantity|qty)\b", re.I)

SEARCH_URLS = {
    "amazon.in": "https://www.amazon.in/s?k={q}",
    "flipkart.com": "https://www.flipkart.com/search?q={q}",
}
CART_URLS = {
    "amazon.in": "https://www.amazon.in/gp/cart/view.html",
    "flipkart.com": "https://www.flipkart.com/viewcart",
}

SECTIONS = ("overview", "specs", "reviews", "images")


@dataclass
class Context:
    req: TurnRequest
    _seq: int = 0

    @property
    def page(self):
        return self.req.page

    @property
    def products(self) -> dict[str, ProductJSON]:
        return {p.id: p for p in self.page.products}

    @property
    def targets(self) -> dict[str, ActionTarget]:
        return {t.id: t for t in self.page.targets}

    def main_product(self) -> ProductJSON | None:
        return self.page.products[0] if self.page.products else None

    def action(
        self, type_: str, target_id: str | None, value: str | None, effect: str, detail: str
    ) -> dict[str, Any]:
        self._seq += 1
        return {
            "schema_version": SCHEMA_VERSION,
            "id": f"act-{self._seq}",
            "type": type_,
            "target_id": target_id,
            "value": value,
            "expected_effect": {"kind": effect, "detail": detail},
        }

    def find_target(self, pattern: re.Pattern[str], zone: str | None = None) -> ActionTarget | None:
        for t in self.page.targets:
            disabled = t.state.disabled if t.state else False
            if pattern.search(t.label) and not disabled and (zone is None or t.zone.value == zone):
                return t
        return None


@dataclass
class ToolResult:
    label: str  # what this does, in a few words ("Add to cart")
    output: AccessibleOutput
    actions: list[dict[str, Any]] = field(default_factory=list)
    confirmation: dict[str, Any] | None = None
    dropped: list[str] = field(default_factory=list)


class ToolInputError(Exception):
    """The model's arguments don't fit the page (unknown id, missing product)."""


def _product(ctx: Context, product_id: str | None) -> ProductJSON:
    """The named product, or the page's own product on a product page."""
    if product_id and product_id in ctx.products:
        return ctx.products[product_id]
    main = ctx.main_product()
    if main is not None and ctx.page.page_type.value == "product":
        return main
    raise ToolInputError(f"unknown product {product_id!r} on a {ctx.page.page_type.value} page")


def _confirmation(
    ctx: Context,
    prompt: str,
    actions: list[dict[str, Any]],
    *,
    risk: str = "low",
    quantity: int | None = None,
    total: tuple[float, str] | None = None,
) -> dict[str, Any]:
    read_back = None
    if quantity is not None or total is not None:
        read_back = {
            "quantity": quantity,
            "total": {"amount": total[0], "currency": total[1]} if total else None,
            "pin_code": None,
        }
    return {
        "schema_version": SCHEMA_VERSION,
        "id": f"conf-{ctx._seq}",
        "prompt": prompt,
        "risk": risk,
        "pending_actions": actions,
        "read_back": read_back,
    }


# --- reading tools -------------------------------------------------------------------------


async def read_section(ctx: Context, section: str, product_id: str | None = None) -> ToolResult:
    p = _product(ctx, product_id)
    if section not in SECTIONS:
        raise ToolInputError(f"unknown section {section!r}")
    out = await prepare.one_section(p, section)
    if out is None:
        out = plain_output(f"I couldn't prepare the {section} right now. Please try again.")
    return ToolResult(f"Read the {section}", out)


async def answer_question(
    ctx: Context, topic: str, field_paths: list[str] | None = None, product_id: str | None = None
) -> ToolResult:
    """Answer a question about one product strictly from its fields."""
    p = _product(ctx, product_id)
    data = p.model_dump(mode="json", by_alias=True)
    paths = list(dict.fromkeys(field_paths or []))
    words = {w for w in re.findall(r"[a-z0-9]{3,}", topic.lower())}
    for key, spec in p.specs.items():  # don't rely on the model knowing the exact keys
        if words & set(re.findall(r"[a-z0-9]{3,}", f"{key} {spec.label}".lower())):
            paths.append(f"specs.{key}")
    b = OutputBuilder(p.id)
    items = []
    for path in dict.fromkeys(paths):
        try:
            value = resolve(data, path)
        except Unresolved:
            continue
        text = _describe(p, path, value)
        if text:
            label, said = text
            items.append(b.item(f"{label}: {said}", "spec", claim=said, path=_leaf(path, value)))
        if len(items) >= 4:
            break
    if not items:
        summary = f"The page doesn't list {topic}."
        out = b.checked({p.id: p}, summary, followups=["Tell me the specs", "Describe the photos"])
        return ToolResult(f"Answer about {topic}", out.output)
    b.section(topic.capitalize(), items)
    summary = items[0]["text"] + "."
    result = b.checked({p.id: p}, summary, followups=["Tell me the specs", "Add to cart"])
    return ToolResult(f"Answer about {topic}", result.output, dropped=result.dropped)


def _leaf(path: str, value: Any) -> str:
    return f"{path}.value" if isinstance(value, dict) and "value" in value else path


def _describe(p: ProductJSON, path: str, value: Any) -> tuple[str, str] | None:
    if re.fullmatch(r"specs\.[a-z0-9_]+(\.value)?", path):
        key = path.split(".")[1]
        spec = p.specs[key]
        return spec.label, brief(spec_value(spec.value, spec.unit), 80)
    if path == "price" or path.startswith("price."):
        if p.price is None:
            return None
        return "Price", money(p.price.amount, p.price.currency)
    if path.startswith("rating"):
        if p.rating is None:
            return None
        return "Rating", f"{number(p.rating.value)} out of 5 from {number(p.rating.count)} ratings"
    if isinstance(value, str | int | float | bool):
        label = path.split(".")[-1].replace("_", " ").capitalize()
        return label, brief(spec_value(value, None), 80)
    return None


async def describe_photo(
    ctx: Context, number: int = 1, product_id: str | None = None
) -> ToolResult:
    """Describe one product photo (1 = main) with the VLM; at most one extra model call."""
    p = _product(ctx, product_id)
    if not p.images:
        return ToolResult(
            "Describe a photo", plain_output("The page doesn't show any product photos.")
        )
    index = max(1, min(int(number or 1), len(p.images))) - 1
    try:
        d = await vision.describe_url(p.images[index].url, p)
    except LLMError:
        img = p.images[index]
        b = OutputBuilder(p.id)
        if img.alt:
            b.ground(img.alt, f"images[{index}].alt")
            text = f"I can't describe photo {index + 1} right now. Its label says: {img.alt}."
        else:
            text = f"I can't describe photo {index + 1} right now."
        b.derive(index + 1)
        return ToolResult("Describe a photo", b.checked({p.id: p}, text).output)
    enriched = vision.with_descriptions(p)
    b = OutputBuilder(p.id)
    said = vision.spoken(d)
    b.ground(said, f"images[{index}].description")
    items = [b.item(f"Colour: {c}") for c in d.colours]
    items += [b.item(f"Shown: {x}") for x in d.items_shown]
    if items:
        b.section(f"Photo {index + 1}", items)
    b.derive(index + 1, len(p.images))
    more = ["Describe the next photo"] if index + 1 < len(p.images) else []
    result = b.checked(
        {p.id: enriched}, said, followups=[*more, "Tell me the specs"], warnings=[vision.AI_NOTE]
    )
    return ToolResult(f"Describe photo {index + 1}", result.output, dropped=result.dropped)


PREFER = {"cheapest": {"price": 1.0}, "best_rated": {"rating": 1.0}, "balanced": {}}


def _stated(ctx: Context, priorities, max_price, min_rating) -> session.Session:
    s = session.get(ctx.req.session_id)
    s.state(priorities, max_price, min_rating)
    return s


async def compare(
    ctx: Context,
    product_ids: list[str] | None = None,
    priorities: list[dict[str, str]] | None = None,
    max_price: float | None = None,
    min_rating: float | None = None,
) -> ToolResult:
    """Compare products on this page and/or ones the shopper looked at earlier (any site),
    ranked by what they said matters."""
    s = _stated(ctx, priorities, max_price, min_rating)
    pool = {**s.seen, **ctx.products}
    chosen = [pool[i] for i in dict.fromkeys(product_ids or []) if i in pool]
    if len(chosen) < 2:
        here = ctx.page.products[:1] if ctx.page.page_type.value == "product" else ctx.page.products
        chosen = list(
            {p.id: p for p in [*chosen, *here, *reversed(list(s.seen.values()))]}.values()
        )
    if len(chosen) < 2:
        out = plain_output(
            "I need at least two products to compare. Open another product, or search, and "
            "ask me again.",
            followups=["Search again"],
        )
        return ToolResult("Compare products", out)
    here = ctx.main_product() if ctx.page.page_type.value == "product" else None
    result = compare_mod.build(
        chosen[:6],
        s.priorities or None,
        max_price=s.max_price,
        min_rating=s.min_rating,
        keep=here.id if here else None,
    )
    return ToolResult("Compare products", result.output, dropped=result.dropped)


async def recommend(
    ctx: Context,
    prefer: str = "balanced",
    max_price: float | None = None,
    min_rating: float | None = None,
    priorities: list[dict[str, str]] | None = None,
) -> ToolResult:
    """Best products on this page for what the shopper wants; sponsored listings never win."""
    s = _stated(ctx, priorities, max_price, min_rating)
    weights = {**PREFER.get(prefer, {}), **s.priorities}
    candidates = [p for p in ctx.page.products if not p.sponsored] or list(ctx.page.products)
    if not candidates:
        return ToolResult(
            "Recommend", plain_output("There are no products on this page to pick from.")
        )
    warnings = (
        ["Sponsored listings were left out."] if len(candidates) < len(ctx.page.products) else []
    )
    result = compare_mod.build(
        candidates,
        weights or None,
        max_price=s.max_price,
        min_rating=s.min_rating,
        heading="Top picks",
        warnings=warnings,
    )
    return ToolResult("Recommend", result.output, dropped=result.dropped)


async def set_preferences(
    ctx: Context,
    priorities: list[dict[str, str]] | None = None,
    max_price: float | None = None,
    min_rating: float | None = None,
) -> ToolResult:
    """Remember what the shopper said matters, for this session's comparisons."""
    s = _stated(ctx, priorities, max_price, min_rating)
    b = OutputBuilder()
    said = []
    important = [f for f, w in s.priorities.items() if w >= 0.6]
    ignored = [f for f, w in s.priorities.items() if w == 0]
    if important:
        said.append(
            f"{join_words([features.LABELS.get(f, f).lower() for f in important])} "
            f"{'matters' if len(important) == 1 else 'matter'} most"
        )
    if ignored:
        said.append(
            f"{join_words([features.LABELS.get(f, f).lower() for f in ignored])} "
            f"{'doesn' if len(ignored) == 1 else 'don'}'t matter"
        )
    if s.max_price is not None:
        b.derive(s.max_price)
        said.append(f"your budget is {money(s.max_price, 'INR')}")
    if s.min_rating is not None:
        b.derive(s.min_rating)
        said.append(f"at least {number(s.min_rating)} stars")
    if not said:
        return ToolResult(
            "Set preferences",
            plain_output("Tell me what matters to you, like camera, battery or price."),
        )
    summary = f"Got it: {'; '.join(said)}. I'll use this when I compare."
    out = b.checked({}, summary, followups=["Compare these", "Which is best for me?"]).output
    return ToolResult("Set preferences", out)


async def where_am_i(ctx: Context) -> ToolResult:
    page = ctx.page
    b = OutputBuilder()
    kind = page.page_type.value.replace("_", " ")
    zones: dict[str, int] = {}
    for t in page.targets:
        zones[t.zone.value] = zones.get(t.zone.value, 0) + 1
    b.derive(len(page.products), *zones.values())
    parts = [f"{n} in {zone}" for zone, n in zones.items()]
    summary = f"This is a {kind} page on {page.site}."
    if page.products and page.page_type.value == "product":
        p = page.products[0]
        if p.title:
            b.ground(short_title(p.title), "title", p.id)
            summary += f" It shows {short_title(p.title)}."
    elif page.products:
        summary += f" It lists {len(page.products)} products."
    items = [b.item(f"Things you can press: {', '.join(parts)}")] if parts else []
    if items:
        b.section("On this page", items)
    result = b.checked(ctx.products, summary, followups=phrase_chips(ctx))
    return ToolResult("Describe this page", result.output)


# --- acting tools ----------------------------------------------------------------------------


async def add_to_cart(ctx: Context, quantity: int = 1, product_id: str | None = None) -> ToolResult:
    p = _product(ctx, product_id)
    button = ctx.find_target(CART)
    if button is None:
        return ToolResult(
            "Add to cart",
            plain_output(
                "I can't find an Add to Cart button on this page.", followups=["Where am I?"]
            ),
        )
    quantity = max(1, min(int(quantity or 1), 10))
    b = OutputBuilder(p.id)
    actions = []
    warnings = []
    if quantity > 1:
        qty = ctx.find_target(QUANTITY)
        if qty is None:
            warnings.append("This page has no quantity selector, so I will add one.")
            quantity = 1
        else:
            actions.append(
                ctx.action("select", qty.id, str(quantity), "value_set", f"Quantity {quantity}")
            )
    actions.append(
        ctx.action(
            "click", button.id, None, "cart_count_increase", f"Cart count goes up by {quantity}"
        )
    )
    name = short_title(p.title) if p.title else "this product"
    if p.title:
        b.ground(name, "title")
    chosen = [
        v
        for v in (p.variants or [])
        if v.selected and v.name.lower() in ("colour", "color", "size")
    ]
    for v in chosen:
        b.ground(v.value, f"variants[{p.variants.index(v)}].value")
    total = None
    price_text = ""
    if p.price is not None:
        b.ground(money(p.price.amount, p.price.currency), "price.amount")
        total = (p.price.amount * quantity, p.price.currency)
        b.derive(total[0])
        price_text = f", for {money(total[0], total[1])}"
    b.derive(quantity)
    variant_text = "".join(f", {v.value}" for v in chosen)
    prompt = f"Add {name}{variant_text}, quantity {quantity}{price_text}, to your cart?"
    result = b.checked({p.id: p}, prompt, followups=["Yes", "No"], warnings=warnings)
    confirmation = _confirmation(
        ctx, result.output.summary, actions, quantity=quantity, total=total
    )
    return ToolResult(
        "Add to cart", result.output, confirmation=confirmation, dropped=result.dropped
    )


async def press(ctx: Context, target_id: str) -> ToolResult:
    """Press a control on the page: a variant swatch, a result link, the cart link..."""
    target = ctx.targets.get(target_id)
    if target is None:
        raise ToolInputError(f"unknown target {target_id!r}")
    label = target.label
    if BLOCKED.search(label):
        out = plain_output(
            "I won't press that for you. Placing an order needs the order summary first, and "
            "you confirm it yourself.",
            followups=["Read my cart"],
        )
        return ToolResult(f"Press {brief(label, 40)}", out)
    if CART.search(label):
        return await add_to_cart(ctx)
    kind = target.kind.value
    if kind in ("swatch", "radio", "checkbox"):
        action = ctx.action("click", target.id, None, "value_set", f"{label} selected")
        verb = "Selecting"
    elif kind in ("link",) or target.zone.value in ("results", "cart"):
        action = ctx.action("click", target.id, None, "url_change", f"Opens {brief(label, 60)}")
        verb = "Opening"
    else:
        action = ctx.action("click", target.id, None, "none", f"Pressed {brief(label, 60)}")
        verb = "Pressing"
    if RISKY.search(label) or CHECKOUT.search(label):
        risk = "high" if RISKY.search(label) else "low"
        prompt = f"Press {brief(label, 60)}?"
        out = plain_output(prompt, followups=["Yes", "No"])
        return ToolResult(
            f"Press {brief(label, 40)}",
            out,
            confirmation=_confirmation(ctx, prompt, [action], risk=risk),
        )
    return ToolResult(
        f"{verb} {brief(label, 40)}", plain_output(f"{verb} {brief(label, 80)}."), actions=[action]
    )


async def search(ctx: Context, query: str) -> ToolResult:
    query = query.strip()
    if not query:
        raise ToolInputError("empty search")
    template = SEARCH_URLS.get(ctx.page.site)
    if template:
        action = ctx.action(
            "navigate",
            None,
            template.format(q=quote_plus(query)),
            "url_change",
            f"Search results for {query}",
        )
        return ToolResult(
            f"Search for {query}", plain_output(f"Searching for {query}."), actions=[action]
        )
    box = next(
        (t for t in ctx.page.targets if t.zone.value == "search" and t.kind.value == "input"), None
    )
    if box is None:
        return ToolResult("Search", plain_output("I can't find a search box on this page."))
    action = ctx.action("fill", box.id, query, "value_set", f"Search box says {query}")
    return ToolResult(
        f"Search for {query}",
        plain_output(f"I typed {query} in the search box. Press Enter to search."),
        actions=[action],
    )


async def go_to_cart(ctx: Context) -> ToolResult:
    link = next(
        (
            t
            for t in ctx.page.targets
            if t.zone.value == "cart" and re.search(r"cart|bag|basket", t.label, re.I)
        ),
        None,
    )
    if link is not None:
        action = ctx.action("click", link.id, None, "url_change", "Cart page opens")
    elif ctx.page.site in CART_URLS:
        action = ctx.action(
            "navigate", None, CART_URLS[ctx.page.site], "url_change", "Cart page opens"
        )
    else:
        return ToolResult("Open the cart", plain_output("I can't find the cart on this page."))
    return ToolResult("Open the cart", plain_output("Opening your cart."), actions=[action])


async def unclear(ctx: Context, heard: str = "") -> ToolResult:
    return ToolResult("Not sure", plain_output("I didn't catch that.", followups=phrase_chips(ctx)))


def phrase_chips(ctx: Context) -> list[str]:
    kind = ctx.page.page_type.value
    if kind == "product":
        return ["Price", "Specs", "Reviews", "Add to cart"]
    if kind == "search":
        return ["Read the results", "Cheapest", "Best rated", "Search again"]
    if kind in ("cart", "checkout"):
        return ["Read my cart", "Where am I?", "Help"]
    return ["Where am I?", "Search", "Help"]


# Chip labels map straight to a tool, without an LLM call.
CHIPS: dict[str, tuple[str, dict[str, Any]]] = {
    "price": ("answer_question", {"topic": "price", "field_paths": ["price"]}),
    "specs": ("read_section", {"section": "specs"}),
    "reviews": ("read_section", {"section": "reviews"}),
    "describe the photos": ("describe_photo", {"number": 1}),
    "describe the next photo": ("describe_photo", {"number": 2}),
    "add to cart": ("add_to_cart", {}),
    "read the results": ("where_am_i", {}),
    "cheapest": ("recommend", {"prefer": "cheapest"}),
    "best rated": ("recommend", {"prefer": "best_rated"}),
    "where am i?": ("where_am_i", {}),
    "read my cart": ("where_am_i", {}),
}

READ_TOOLS = {
    "read_section",
    "answer_question",
    "describe_photo",
    "compare",
    "recommend",
    "where_am_i",
    "unclear",
    "set_preferences",
}


def label_for(name: str, args: dict[str, Any]) -> str:
    """A short spoken label for a reading tool, without running it."""
    if name == "read_section":
        return f"Read the {args.get('section', 'details')}"
    if name == "answer_question":
        return f"Tell you about {args.get('topic', 'that')}"
    if name == "recommend":
        prefer = args.get("prefer")
        return {"cheapest": "Find the cheapest", "best_rated": "Find the best rated"}.get(
            prefer, "Suggest the best options"
        )
    if name == "describe_photo":
        return "Describe the photo"
    if name == "set_preferences":
        return "Remember what matters to you"
    return {"compare": "Compare products", "where_am_i": "Describe this page"}.get(name, "Help")


Tool = Callable[..., Awaitable[ToolResult]]

TOOLS: dict[str, Tool] = {
    "read_section": read_section,
    "answer_question": answer_question,
    "describe_photo": describe_photo,
    "compare": compare,
    "recommend": recommend,
    "set_preferences": set_preferences,
    "where_am_i": where_am_i,
    "add_to_cart": add_to_cart,
    "press": press,
    "search": search,
    "go_to_cart": go_to_cart,
    "unclear": unclear,
}

_COMMON = {
    "confidence": {
        "type": "number",
        "description": "Probability 0-1 that this is what the user meant. >=0.8 only when clear.",
    },
    "alternatives": {
        "type": "array",
        "description": "Up to 2 OTHER plausible meanings, each a different tool or different "
        "arguments from your choice (e.g. 'a cart': add_to_cart vs go_to_cart). Most likely first.",
        "items": {
            "type": "object",
            "properties": {
                "label": {"type": "string", "description": "Short, e.g. 'Add to cart'"},
                "tool": {"type": "string", "enum": list(TOOLS)},
                "arguments_json": {
                    "type": "string",
                    "description": "That tool's arguments as JSON",
                },
            },
            "required": ["label", "tool", "arguments_json"],
        },
    },
}


def _spec(
    name: str, description: str, props: dict[str, Any], required: list[str]
) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": {**props, **_COMMON},
                "required": [*required, "confidence", "alternatives"],
            },
        },
    }


_PID = {
    "product_id": {"type": "string", "description": "A product id from PAGE; omit for this product"}
}

_PREFS = {
    "priorities": {
        "type": "array",
        "description": "Features the user said matter (or don't).",
        "items": {
            "type": "object",
            "properties": {
                "feature": {"type": "string", "enum": features.ALL_NAMES},
                "importance": {
                    "type": "string",
                    "enum": ["must", "high", "medium", "low", "ignore"],
                },
            },
            "required": ["feature", "importance"],
        },
    },
    "max_price": {"type": "number", "description": "Budget in rupees, if stated"},
    "min_rating": {"type": "number"},
}

TOOL_SPECS = [
    _spec(
        "read_section",
        "Read a WHOLE prepared section, only when the user asks for it as a whole: 'tell me "
        "about this', 'read the specs', 'what do reviews say'. For a question about one "
        "specific thing use answer_question; for photos use describe_photo.",
        {"section": {"type": "string", "enum": list(SECTIONS)}, **_PID},
        ["section"],
    ),
    _spec(
        "answer_question",
        "Answer a question about ONE specific thing of a product from its page data: "
        "warranty, battery, weight, size, material, price, delivery, seller, what's in the "
        "box. Prefer this over read_section whenever the user names a specific thing.",
        {
            "topic": {
                "type": "string",
                "description": "What is asked, in English, e.g. 'battery capacity'",
            },
            "field_paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": "ProductJSON paths that may hold it, e.g. specs.battery",
            },
            **_PID,
        },
        ["topic"],
    ),
    _spec(
        "describe_photo",
        "Describe a product photo for someone who cannot see it (1 = main photo).",
        {"number": {"type": "integer"}, **_PID},
        [],
    ),
    _spec(
        "compare",
        "Compare products: ones on this page and/or ones the user looked at earlier (SEEN, "
        "any site). Pass any priorities or budget the user states in this utterance.",
        {
            "product_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Ids from PAGE or SEEN; omit to compare this product with the "
                "ones seen before (or the results on a search page)",
            },
            **_PREFS,
        },
        [],
    ),
    _spec(
        "recommend",
        "Pick the best products on this page for what the user wants (budget, cheapest, "
        "best rated, or features that matter to them).",
        {
            "prefer": {"type": "string", "enum": ["cheapest", "best_rated", "balanced"]},
            **_PREFS,
        },
        ["prefer"],
    ),
    _spec(
        "set_preferences",
        "Remember what matters to the user when choosing, e.g. 'I want a good camera, battery "
        "doesn't matter, under 20000'. Use when they state preferences without asking for a "
        "comparison.",
        dict(_PREFS),
        [],
    ),
    _spec("where_am_i", "Describe the current page and what can be done on it.", {}, []),
    _spec(
        "add_to_cart",
        "Add the product to the cart (the user will be asked to confirm).",
        {"quantity": {"type": "integer"}, **_PID},
        [],
    ),
    _spec(
        "press",
        "Press a control on the page by its target id: choose a colour/size, open a result, "
        "open a link.",
        {"target_id": {"type": "string"}},
        ["target_id"],
    ),
    _spec(
        "search",
        "Search the shop for products.",
        {"query": {"type": "string", "description": "In English or as the user said it"}},
        ["query"],
    ),
    _spec("go_to_cart", "Open the shopping cart.", {}, []),
    _spec(
        "unclear",
        "Use when you cannot tell what the user wants.",
        {"heard": {"type": "string"}},
        [],
    ),
]


def parse_alternatives(raw: Any) -> list[tuple[str, str, dict[str, Any]]]:
    out = []
    for alt in raw if isinstance(raw, list) else []:
        try:
            args = json.loads(alt.get("arguments_json") or "{}")
        except (json.JSONDecodeError, AttributeError):
            continue
        if alt.get("tool") in TOOLS and isinstance(args, dict):
            out.append((str(alt.get("label") or alt["tool"]), alt["tool"], args))
    return out[:2]


async def run(ctx: Context, name: str, args: dict[str, Any]) -> ToolResult:
    if name not in TOOLS:
        raise ToolInputError(f"unknown tool {name!r}")
    args = {k: v for k, v in args.items() if k not in ("confidence", "alternatives")}
    try:
        return await TOOLS[name](ctx, **args)
    except TypeError as exc:
        raise ToolInputError(f"bad arguments for {name}: {exc}") from exc


__all__ = [
    "CHIPS",
    "TOOLS",
    "TOOL_SPECS",
    "Context",
    "ToolInputError",
    "ToolResult",
    "phrase_chips",
    "run",
]
