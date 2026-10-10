"""Comparable features from differently-named specs (Amazon, Flipkart, SerpApi, generic pages).

The same thing is written many ways: "12, 5, 50 MP" under rear_facing_camera_photo_sensor_
resolution, "50MP Rear Camera" under primary_camera, "5000 milliamp_hours", "6000 mAh",
"17.13 cm (6.745 inch)". Each feature matches on the spec's key AND on its value's unit, and
keeps the page's own text (said aloud) and its field path (grounding). Unit conversions
(kg -> g, TB -> GB) only feed the ranking; they are never said. Nothing is filled in: a product
without a feature is "not listed" for it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from app.brain.format import brief, money, number, spec_value
from app.models import ProductJSON


@dataclass(frozen=True)
class Value:
    number: float  # for ranking only
    text: str  # the page's wording, said aloud
    path: str  # grounding: dot path into the product


@dataclass(frozen=True)
class Feature:
    name: str
    label: str
    higher_is_better: bool
    key: re.Pattern[str] | None = None
    reject_key: re.Pattern[str] | None = None
    unit: re.Pattern[str] | None = None  # value must mention this unit
    parse: Callable[[str], float | None] | None = None


def _first(text: str) -> float | None:
    m = re.search(r"\d+(?:\.\d+)?", text.replace(",", ""))
    return float(m.group()) if m else None


def _max_mp(text: str) -> float | None:
    nums = [float(n) for n in re.findall(r"(\d+(?:\.\d+)?)\s*(?:MP\b|megapixel)", text, re.I)]
    if not nums and re.search(r"\bMP\b|megapixel", text, re.I):  # "12, 5, 50 MP"
        nums = [float(n) for n in re.findall(r"\d+(?:\.\d+)?", text)]
    nums = [n for n in nums if 0 < n <= 300]
    return max(nums) if nums else None


def _number_before(unit: str) -> Callable[[str], float | None]:
    pattern = re.compile(rf"(\d+(?:\.\d+)?)\s*(?:{unit})", re.I)

    def parse(text: str) -> float | None:
        m = pattern.search(text.replace(",", ""))
        return float(m.group(1)) if m else None

    return parse


def _gigabytes(text: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(TB|GB|MB)\b", text, re.I)
    if not m:
        return None
    n, u = float(m.group(1)), m.group(2).upper()
    return n * 1024 if u == "TB" else n / 1024 if u == "MB" else n


def _grams(text: str) -> float | None:
    m = re.search(r"(\d+(?:\.\d+)?)\s*(kilograms?|kg|grams?|g)\b", text, re.I)
    if not m:
        return None
    n = float(m.group(1))
    return n * 1000 if m.group(2).lower().startswith("k") else n


def _k(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.I)


FEATURES: list[Feature] = [
    Feature("camera", "Main camera", True,
            key=_k(r"rear|primary_camera|^camera|main_camera|back_camera"),
            reject_key=_k(r"front|selfie|number_of|flash|description|available|lens"),
            unit=_k(r"MP\b|megapixel"), parse=_max_mp),
    Feature("front_camera", "Front camera", True,
            key=_k(r"front|selfie|secondary_camera"), reject_key=_k(r"number_of"),
            unit=_k(r"MP\b|megapixel"), parse=_max_mp),
    Feature("battery", "Battery", True, key=_k(r"battery"),
            unit=_k(r"mah|milliamp"), parse=_first),
    Feature("battery_life", "Battery life", True, key=_k(r"battery|playback|playtime|life"),
            reject_key=_k(r"charge_time|charging"),
            unit=_k(r"\b(hours?|hrs?|hr)\b"), parse=_number_before(r"hours?|hrs?|hr\b")),
    Feature("ram", "RAM", True, key=_k(r"(^|_)ram(_|$)"), unit=_k(r"\b[GT]B\b"), parse=_gigabytes),
    Feature("storage", "Storage", True, key=_k(r"storage|(^|_)rom(_|$)|internal|memory_storage"),
            reject_key=_k(r"expandable|card"), unit=_k(r"\b[GT]B\b"), parse=_gigabytes),
    Feature("screen", "Screen size", True, key=_k(r"screen|display"),
            reject_key=_k(r"resolution|type|density|refresh"),
            unit=_k(r"inch|\bin\b|″|\""), parse=_number_before(r"inch(?:es)?|in\b|″|\"")),
    Feature("refresh_rate", "Refresh rate", True, key=_k(r"refresh"), parse=_first),
    Feature("weight", "Weight", False, key=_k(r"weight"), reject_key=_k(r"capacity|load"),
            unit=_k(r"\b(kilograms?|kg|grams?|g)\b"), parse=_grams),
    Feature("capacity", "Capacity", True, key=_k(r"capacity"), reject_key=_k(r"battery"),
            unit=_k(r"lit(re|er)s?|\bl\b"), parse=_first),
    Feature("power", "Power", True, key=_k(r"watt|power"), reject_key=_k(r"battery"),
            unit=_k(r"\bw(atts?)?\b"), parse=_first),
]  # fmt: skip

BY_NAME = {f.name: f for f in FEATURES}
ALL_NAMES = ["price", "rating", *BY_NAME]
LABELS = {"price": "Price", "rating": "Rating", **{f.name: f.label for f in FEATURES}}
LOWER_IS_BETTER = {"price", *(f.name for f in FEATURES if not f.higher_is_better)}


def extract(p: ProductJSON) -> dict[str, Value]:
    """All comparable features this product's page states."""
    out: dict[str, Value] = {}
    if p.price is not None:
        out["price"] = Value(
            p.price.amount, money(p.price.amount, p.price.currency), "price.amount"
        )
    if p.rating is not None:
        out["rating"] = Value(p.rating.value, f"{number(p.rating.value)} out of 5", "rating.value")
    for feature in FEATURES:
        for key, spec in p.specs.items():
            if feature.key and not feature.key.search(key):
                continue
            if feature.reject_key and feature.reject_key.search(key):
                continue
            # Parse only what will be said, so the number ranked is a number the user hears
            # ("Panorama (up to 63MP)" deep in a camera paragraph is not the main camera).
            text = brief(spec_value(spec.value, spec.unit), 50)
            if feature.unit and not feature.unit.search(text):
                continue
            n = feature.parse(text) if feature.parse else None
            if n is None:
                continue
            out[feature.name] = Value(n, text, f"specs.{key}.value")
            break
    return out
