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

from app.brain import prepare, recommender
from app.brain.format import brief, join_words, money, number, short_title, spec_value
from app.brain.grounding import Unresolved, resolve
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
        return ToolResult(f"Answer about {topic}", b.checked({p.id: p}, summary).output)
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


async def compare(ctx: Context, product_ids: list[str]) -> ToolResult:
    chosen = [ctx.products[i] for i in dict.fromkeys(product_ids) if i in ctx.products]
    if len(chosen) < 2:
        chosen = ctx.page.products[:3]
    if len(chosen) < 2:
        raise ToolInputError("need two products to compare")
    b = OutputBuilder()
    names = [short_title(p.title) if p.title else p.id for p in chosen]
    rows = [
        ["Price"]
        + [money(p.price.amount, p.price.currency) if p.price else "not listed" for p in chosen],
        ["Rating"]
        + [
            f"{number(p.rating.value)} ({number(p.rating.count)} ratings)"
            if p.rating
            else "not listed"
            for p in chosen
        ],
    ]
    shared = [k for k in chosen[0].specs if all(k in p.specs for p in chosen[1:])][:4]
    for key in shared:
        rows.append(
            [chosen[0].specs[key].label]
            + [brief(spec_value(p.specs[key].value, p.specs[key].unit), 30) for p in chosen]
        )
    spoken = []
    for name, p in zip(names, chosen, strict=True):
        if p.title:
            b.ground(name, "title", p.id)
        parts = []
        if p.price:
            b.ground(money(p.price.amount, p.price.currency), "price.amount", p.id)
            parts.append(f"costs {money(p.price.amount, p.price.currency)}")
        if p.rating:
            b.ground(number(p.rating.value), "rating.value", p.id)
            b.ground(number(p.rating.count), "rating.count", p.id)
            parts.append(f"is rated {number(p.rating.value)}")
        for key in shared:
            b.ground(
                brief(spec_value(p.specs[key].value, p.specs[key].unit), 30),
                f"specs.{key}.value",
                p.id,
            )
        spoken.append(f"{name} {join_words(parts) or 'has no price or rating on the page'}.")
    table = {"columns": [""] + names, "rows": rows, "spoken": " ".join(spoken)}
    b.section("Comparison", table=table)
    b.derive(len(chosen))
    result = b.checked(
        {p.id: p for p in chosen},
        f"I compared {len(chosen)} products. {spoken[0]}",
        followups=["Which is cheapest?", "Which is best rated?"],
    )
    return ToolResult("Compare products", result.output, dropped=result.dropped)


async def recommend(
    ctx: Context,
    prefer: str = "balanced",
    max_price: float | None = None,
    min_rating: float | None = None,
) -> ToolResult:
    prefer = prefer if prefer in recommender.WEIGHTS else "balanced"
    ranked = recommender.rank(ctx.page.products, prefer, max_price=max_price, min_rating=min_rating)  # type: ignore[arg-type]
    b = OutputBuilder()
    if not ranked:
        return ToolResult(
            "Recommend",
            plain_output("No product on this page matches that.", followups=["Search again"]),
        )
    top = ranked[:3]
    items = []
    for i, r in enumerate(top, 1):
        p = r.product
        name = short_title(p.title) if p.title else p.id
        b.derive(i)
        bits = [name]
        if p.title:
            b.ground(name, "title", p.id)
        if p.price:
            b.ground(money(p.price.amount, p.price.currency), "price.amount", p.id)
            bits.append(money(p.price.amount, p.price.currency))
        if p.rating:
            b.ground(number(p.rating.value), "rating.value", p.id)
            bits.append(f"rated {number(p.rating.value)}")
        items.append(
            b.item(
                f"{i}. " + ", ".join(bits),
                path="title" if p.title else None,
                subject_id=p.id,
                claim=name,
            )
        )
    b.section("Top picks", items)
    why = {
        "cheapest": "lowest price",
        "best_rated": "highest rating",
        "balanced": "price and rating together",
    }
    b.derive(len(ranked))
    first = items[0]["text"].split(". ", 1)[1]
    result = b.checked(
        {r.product.id: r.product for r in ranked},
        f"Best match by {why[prefer]}: {first}.",
        followups=["Open the first one", "Compare the top two"],
        warnings=["Sponsored listings were left out."]
        if any(p.sponsored for p in ctx.page.products)
        else [],
    )
    return ToolResult("Recommend", result.output, dropped=result.dropped)


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
    "add to cart": ("add_to_cart", {}),
    "read the results": ("where_am_i", {}),
    "cheapest": ("recommend", {"prefer": "cheapest"}),
    "best rated": ("recommend", {"prefer": "best_rated"}),
    "where am i?": ("where_am_i", {}),
    "read my cart": ("where_am_i", {}),
}

READ_TOOLS = {"read_section", "answer_question", "compare", "recommend", "where_am_i", "unclear"}


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
    return {"compare": "Compare products", "where_am_i": "Describe this page"}.get(name, "Help")


Tool = Callable[..., Awaitable[ToolResult]]

TOOLS: dict[str, Tool] = {
    "read_section": read_section,
    "answer_question": answer_question,
    "compare": compare,
    "recommend": recommend,
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
        "description": "Up to 2 other plausible meanings, most likely first.",
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

TOOL_SPECS = [
    _spec(
        "read_section",
        "Read a prepared summary of a product: overview (price, rating, delivery), specs, "
        "reviews, or images (photos).",
        {"section": {"type": "string", "enum": list(SECTIONS)}, **_PID},
        ["section"],
    ),
    _spec(
        "answer_question",
        "Answer a specific question about a product (e.g. battery, weight, warranty, price) "
        "from its page data.",
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
        "compare",
        "Compare two or more products listed on the page.",
        {"product_ids": {"type": "array", "items": {"type": "string"}}},
        ["product_ids"],
    ),
    _spec(
        "recommend",
        "Pick the best products on this page for the user's stated preference or budget.",
        {
            "prefer": {"type": "string", "enum": ["cheapest", "best_rated", "balanced"]},
            "max_price": {"type": "number"},
            "min_rating": {"type": "number"},
        },
        ["prefer"],
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
