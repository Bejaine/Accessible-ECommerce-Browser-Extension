"""Deterministic section builders over ProductJSON: overview, specs, images.

Every fact comes from a field and carries its grounding; missing fields are said out loud
("the page doesn't list ..."), never filled in. Output is English; /turn translates lazily.
"""

from __future__ import annotations

from app.brain.format import brief, join_words, money, number, short_title, spec_value
from app.brain.grounding import CheckResult
from app.brain.output import Item, OutputBuilder
from app.models import ProductJSON

MAX_SUMMARY = 400
MAX_SPEC_ITEMS = 10
# Specs buyers ask about first, by key fragment; others keep page order after these.
SPEC_PRIORITY = (
    "battery", "ram", "storage", "capacity", "screen", "display", "processor", "chip",
    "camera", "operating_system", "os", "water", "weight", "warranty", "in_the_box",
)  # fmt: skip


def product_name(p: ProductJSON) -> str:
    return short_title(p.title) if p.title else "This product"


def _subjects(p: ProductJSON) -> dict[str, ProductJSON]:
    return {p.id: p}


def _fit(*sentences: str) -> str:
    """Keep the summary to at most two sentences and the schema's length limit."""
    out = ""
    for s in sentences[:2]:
        candidate = f"{out} {s}".strip()
        if len(candidate) > MAX_SUMMARY:
            break
        out = candidate
    return out or sentences[0][:MAX_SUMMARY]


def price_sentence(b: OutputBuilder, p: ProductJSON, name: str) -> str:
    if p.title:
        b.ground(name, "title")
    if p.price is None:
        return f"The page doesn't list the price of {name}."
    b.ground(money(p.price.amount, p.price.currency), "price.amount")
    text = f"{name} costs {money(p.price.amount, p.price.currency)}"
    if p.price.mrp is not None and p.price.mrp > p.price.amount:
        mrp = money(p.price.mrp, p.price.currency)
        b.ground(mrp, "price.mrp")
        text += f", down from {mrp}"
    return text + "."


def rating_sentence(b: OutputBuilder, p: ProductJSON) -> str:
    if p.rating is None:
        return "The page doesn't list a rating."
    value, count = number(p.rating.value), number(p.rating.count)
    b.ground(f"rated {value}", "rating.value")
    b.ground(f"{count} ratings", "rating.count")
    return f"It is rated {value} out of 5 from {count} ratings."


async def overview(p: ProductJSON) -> CheckResult:
    b = OutputBuilder(p.id)
    name = product_name(p)
    price = price_sentence(b, p, name)
    rating = rating_sentence(b, p)

    items = []
    if p.availability is not None:
        if p.availability.text:
            items.append(b.item(p.availability.text, path="availability.text"))
        else:
            status = p.availability.status.value.replace("_", " ").capitalize()
            items.append(b.item(status, path="availability.status"))
    else:
        items.append(b.item("The page doesn't say whether it is in stock."))
    if p.delivery is not None:
        items.append(b.item(p.delivery.text, path="delivery.text"))
    else:
        items.append(b.item("The page doesn't list delivery details."))
    if p.seller:
        items.append(b.item(f"Sold by {p.seller}", claim=p.seller, path="seller"))
    items.extend(variant_items(b, p))
    b.section("At a glance", items)

    warnings = ["This is a sponsored listing."] if p.sponsored else []
    simple_price = f"{name} costs {money(p.price.amount, p.price.currency)}." if p.price else None
    return b.checked(
        _subjects(p),
        _fit(price, rating),
        simpler=simple_price,
        followups=[
            "Tell me the specs",
            "What do reviews say?",
            "Describe the photos",
            "Add to cart",
        ],
        warnings=warnings,
    )


async def specs(p: ProductJSON) -> CheckResult:
    b = OutputBuilder(p.id)
    if not p.specs:
        return b.checked(
            _subjects(p),
            "The page doesn't list any specs for this product.",
            followups=["What do reviews say?", "Describe the photos"],
        )
    keys = ranked_spec_keys(p)
    items = [spec_item(b, key, p) for key in keys[:MAX_SPEC_ITEMS]]
    if len(keys) > MAX_SPEC_ITEMS:
        b.derive(len(keys) - MAX_SPEC_ITEMS)
        items.append(b.item(f"The page lists {len(keys) - MAX_SPEC_ITEMS} more specs."))
    b.section("Specs", items)
    short = [k for k in keys if len(_value(p, k)) <= 30] or keys
    key_specs = [f"{p.specs[k].label} {brief(_value(p, k), 30)}" for k in short[:3]]
    b.derive(len(p.specs))
    count = f"The page lists {len(p.specs)} specs."
    return b.checked(
        _subjects(p),
        _fit(count, f"Key ones: {join_words(key_specs)}."),
        followups=["What do reviews say?", "Describe the photos", "Add to cart"],
        warnings=spec_warnings(b, p),
    )


def _value(p: ProductJSON, key: str) -> str:
    spec = p.specs[key]
    return spec_value(spec.value, spec.unit)


def ranked_spec_keys(p: ProductJSON) -> list[str]:
    def rank(item: tuple[int, str]) -> tuple[int, int]:
        position, key = item
        hit = next((i for i, part in enumerate(SPEC_PRIORITY) if part in key), len(SPEC_PRIORITY))
        return hit, position

    return [key for _, key in sorted(enumerate(p.specs), key=rank)]


def spec_item(b: OutputBuilder, key: str, p: ProductJSON) -> Item:
    """One spec, its long value cut to the first clause (still word for word from the page)."""
    value = brief(_value(p, key), 60)
    return b.item(f"{p.specs[key].label}: {value}", "spec", claim=value, path=f"specs.{key}.value")


def spec_warnings(b: OutputBuilder, p: ProductJSON) -> list[str]:
    """Point out what looks like a listing error, quoting the page (never correcting it)."""
    ram = next((k for k in p.specs if "ram" in k.split("_")), None)
    storage = next((k for k in p.specs if "storage" in k), None)
    if not ram or not storage:
        return []
    a, c = p.specs[ram], p.specs[storage]
    if not isinstance(a.value, int | float) or (a.value, a.unit) != (c.value, c.unit):
        return []
    size = spec_value(a.value, a.unit)
    b.ground(size, f"specs.{ram}.value")
    b.ground(size, f"specs.{storage}.value")
    return [
        f"The page lists the same size, {size}, for RAM and for storage. "
        "One of them may be a listing error."
    ]


def variant_items(b: OutputBuilder, p: ProductJSON) -> list[Item]:
    """One item per variant dimension, citing every option it names."""
    items = []
    for dimension in dict.fromkeys(v.name for v in p.variants or []):
        options = [(i, v) for i, v in enumerate(p.variants or []) if v.name == dimension]
        names = [f"{v.value} (selected)" if v.selected else v.value for _, v in options]
        for i, v in options:
            b.ground(v.value, f"variants[{i}].value")
        items.append(
            b.item(
                f"{dimension.capitalize()}: {', '.join(names)}",
                claim=", ".join(v.value for _, v in options),
                path="variants",
            )
        )
    return items


async def images(p: ProductJSON, warnings: list[str] | None = None) -> CheckResult:
    b = OutputBuilder(p.id)
    if not p.images:
        return b.checked(_subjects(p), "The page doesn't show any product photos.")
    shown = p.images[:3]
    items = []
    for i, img in enumerate(shown):
        b.derive(i + 1)
        if img.description:
            items.append(b.item(img.description, path=f"images[{i}].description"))
        elif img.alt:
            items.append(
                b.item(f"Photo {i + 1}: {img.alt}", claim=img.alt, path=f"images[{i}].alt")
            )
        else:
            items.append(b.item(f"Photo {i + 1} has no description on the page."))
        if img.ocr_text:
            items.append(
                b.item(
                    f"Text on photo {i + 1}: {img.ocr_text}",
                    claim=img.ocr_text,
                    path=f"images[{i}].ocr_text",
                )
            )
    b.section("Photos", items)
    b.derive(len(p.images))
    plural = "photo" if len(p.images) == 1 else "photos"
    first = shown[0].description or shown[0].alt
    second = (
        f"The first shows {brief(first, 80)}." if first else "The first photo has no description."
    )
    return b.checked(
        _subjects(p),
        _fit(f"There are {len(p.images)} product {plural}.", second),
        followups=["Describe the next photo", "Tell me the specs"],
        warnings=warnings or [],
    )
