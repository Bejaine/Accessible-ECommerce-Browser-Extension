"""Compare products by what the shopper said matters (docs/product.md: hard constraints filter,
normalised features get weights from the user's stated preferences, code ranks, words explain).

Weights come only from what the shopper said ("camera matters, battery doesn't", a budget),
never from their disability profile. With no stated preference: price and rating, plus a little
of every feature the products share. A product that doesn't list a feature gets nothing for it
(it is never assumed), and the table says "not listed".
"""

from __future__ import annotations

from dataclasses import dataclass

from app.brain import features
from app.brain.format import join_words, money, short_title
from app.brain.grounding import CheckResult
from app.brain.output import OutputBuilder
from app.models import ProductJSON

DEFAULT_WEIGHTS = {"price": 0.5, "rating": 0.5}
SHARED_FEATURE_WEIGHT = 0.15  # each other feature the products share, when nothing was stated
UNSTATED_WEIGHT = 0.1  # features the shopper didn't mention, once they stated some
UNSTATED_BASICS = 0.3  # price and rating still count unless the shopper says otherwise
MAX_ROWS = 7


@dataclass
class Ranked:
    product: ProductJSON
    score: float
    values: dict[str, features.Value]


def name_of(p: ProductJSON) -> str:
    return short_title(p.title) if p.title else p.id


def rank(
    products: list[ProductJSON],
    priorities: dict[str, float] | None = None,
    *,
    max_price: float | None = None,
    min_rating: float | None = None,
) -> tuple[list[Ranked], dict[str, float], list[ProductJSON]]:
    """Returns (ranked, weights used, products filtered out by the hard constraints)."""
    values = {p.id: features.extract(p) for p in products}
    kept, excluded = [], []
    for p in products:
        v = values[p.id]
        too_dear = max_price is not None and ("price" not in v or v["price"].number > max_price)
        too_low = min_rating is not None and ("rating" not in v or v["rating"].number < min_rating)
        (excluded if too_dear or too_low else kept).append(p)

    # Features at least two products list, plus anything the shopper asked about even if only
    # one lists it (the others then say "not listed" and get nothing for it).
    stated = {f for f, w in (priorities or {}).items() if w > 0}
    shared = [
        f
        for f in features.ALL_NAMES
        if sum(f in values[p.id] for p in kept) >= (1 if f in stated or len(kept) == 1 else 2)
    ]
    if priorities:
        weights = {
            f: priorities.get(f, UNSTATED_BASICS if f in DEFAULT_WEIGHTS else UNSTATED_WEIGHT)
            for f in shared
        }
        weights.update({f: w for f, w in priorities.items() if f in shared})
    else:
        weights = {f: DEFAULT_WEIGHTS.get(f, SHARED_FEATURE_WEIGHT) for f in shared}

    def norm(feature: str, p: ProductJSON) -> float:
        v = values[p.id].get(feature)
        if v is None:
            return 0.0
        nums = [values[q.id][feature].number for q in kept if feature in values[q.id]]
        lo, hi = min(nums), max(nums)
        if hi == lo:
            return 1.0
        x = (v.number - lo) / (hi - lo)
        return 1 - x if feature in features.LOWER_IS_BETTER else x

    ranked = [
        Ranked(p, sum(w * norm(f, p) for f, w in weights.items()), values[p.id]) for p in kept
    ]
    ranked.sort(key=lambda r: -round(r.score, 6))  # stable: page order breaks ties
    return ranked, weights, excluded


def _reason(best: Ranked, other: Ranked, weights: dict[str, float]) -> list[str]:
    """Features (most important first) where the winner is better, as page values."""
    out = []
    for f, w in sorted(weights.items(), key=lambda kv: -kv[1]):
        if w <= 0 or f not in best.values or f not in other.values:
            continue
        a, b = best.values[f].number, other.values[f].number
        better = a < b if f in features.LOWER_IS_BETTER else a > b
        if better:
            out.append(f)
        if len(out) == 2:
            break
    return out


def build(
    products: list[ProductJSON],
    priorities: dict[str, float] | None = None,
    *,
    max_price: float | None = None,
    min_rating: float | None = None,
    top: int = 3,
    heading: str = "Comparison",
    warnings: list[str] | None = None,
    keep: str | None = None,
) -> CheckResult:
    """`keep`: a product id that must be shown (the one the shopper is looking at)."""
    """A grounded comparison: summary (who comes first and why), a table, the ranking."""
    ranked, weights, excluded = rank(
        products, priorities, max_price=max_price, min_rating=min_rating
    )
    b = OutputBuilder()
    subjects = {p.id: p for p in products}
    if not ranked:
        why = "your budget" if max_price is not None else "what you asked for"
        if max_price is not None:
            b.derive(max_price)
        return b.checked(subjects, f"None of these products fit {why}.", followups=["Search again"])

    shown = ranked[:top]
    kept_rank = next((i for i, r in enumerate(ranked, 1) if r.product.id == keep), None)
    if kept_rank is not None and kept_rank > top:
        shown = [*ranked[: top - 1], ranked[kept_rank - 1]]
    for r in shown:
        if r.product.title:
            b.ground(name_of(r.product), "title", r.product.id)

    # Table rows: the stated priorities first, then price and rating, then shared features.
    order = sorted(
        weights, key=lambda f: (-(priorities or {}).get(f, -1), f not in ("price", "rating"))
    )
    rows = []
    for f in order[:MAX_ROWS]:
        if (priorities or {}).get(f) == 0:
            continue  # "I don't care about battery": don't read it out
        row = [features.LABELS[f]]
        for r in shown:
            v = r.values.get(f)
            if v is None:
                row.append("not listed")
            else:
                b.ground(v.text, v.path, r.product.id)
                row.append(v.text)
        rows.append(row)

    best = shown[0]
    names = [name_of(r.product) for r in shown]
    stated = bool(priorities) and any(w > 0 for w in priorities.values())
    basics = all(f in weights for f in DEFAULT_WEIGHTS)
    lead = "For what you asked" if stated else "On price and rating" if basics else "Overall"
    asked = [f for f, w in (priorities or {}).items() if w > 0]
    unknown = [f for f in asked if not any(f in r.values for r in ranked)]
    if asked and len(unknown) == len(asked):
        # Seen live: "the best battery" on a search page where no listing gives a battery.
        labels = join_words([features.LABELS.get(f, f).lower() for f in unknown])
        lead = f"None of these listings show the {labels}, so on price and rating"
    summary = f"{lead}, {names[0]} comes first."
    items = []
    if len(shown) == 1:
        basics_said = [best.values[f].text for f in ("price", "rating") if f in best.values]
        summary = f"Only one fits: {names[0]}" + (
            f", {join_words(basics_said)}." if basics_said else "."
        )
        for f in ("price", "rating"):
            if f in best.values:
                b.ground(best.values[f].text, best.values[f].path, best.product.id)
    if len(shown) > 1:
        reasons = _reason(best, shown[1], weights)
        top_stated = max(priorities, key=priorities.get) if stated else None
        only_one = top_stated and top_stated in best.values and top_stated not in shown[1].values
        if only_one:
            label = features.LABELS[top_stated].lower()
            summary += (
                f" It is the only one whose page lists the {label}: {best.values[top_stated].text}."
            )
            reasons = []
        tie = (
            top_stated
            and top_stated in best.values
            and top_stated in shown[1].values
            and best.values[top_stated].number == shown[1].values[top_stated].number
        )
        if tie:
            label = features.LABELS[top_stated].lower()
            summary += (
                f" Both have the same {label} ({best.values[top_stated].text} and "
                f"{shown[1].values[top_stated].text})."
            )
            reasons = [f for f in reasons if f != top_stated][:1]
            if reasons:
                f = reasons[0]
                summary = summary.rstrip(".") + (
                    f"; it wins on {features.LABELS[f].lower()}, {best.values[f].text} against "
                    f"{shown[1].values[f].text}."
                )
        elif reasons:
            parts = [
                f"{features.LABELS[f].lower()} {best.values[f].text} against "
                f"{shown[1].values[f].text}"
                for f in reasons
            ]
            summary += f" It has the better {join_words(parts)}."
        if kept_rank is not None and kept_rank > 1:
            b.derive(kept_rank, len(ranked))
            this = next(r for r in shown if r.product.id == keep)
            items.append(
                b.item(
                    f"This one, {name_of(this.product)}, ranks {kept_rank} of {len(ranked)}.",
                    claim=name_of(this.product),
                    path="title",
                    subject_id=keep,
                )
            )
        for i, r in enumerate(shown, 1):
            b.derive(i)
            missing = [
                features.LABELS[f].lower() for f in weights if weights[f] > 0 and f not in r.values
            ]
            position = kept_rank if r.product.id == keep and kept_rank else i
            b.derive(position)
            text = f"{position}. {names[i - 1]}"
            if missing:
                text += f" (the page doesn't list {join_words(missing[:3])})"
            items.append(b.item(text, claim=names[i - 1], path="title", subject_id=r.product.id))
    spoken = " ".join(
        f"{n}: " + ", ".join(f"{row[0]} {row[j + 1]}" for row in rows) + "."
        for j, n in enumerate(names)
    )
    b.section(heading, items, table={"columns": ["", *names], "rows": rows, "spoken": spoken})
    notes = list(warnings or [])
    for r in shown:  # a listing error that would mislead the comparison (seen: iPhone RAM)
        ram, storage = r.values.get("ram"), r.values.get("storage")
        if ram and storage and ram.number == storage.number:
            b.ground(ram.text, ram.path, r.product.id)
            notes.append(
                f"{name_of(r.product)}'s page lists the same size, {ram.text}, for RAM and "
                "storage. One of them may be a listing error."
            )
    if excluded:
        b.derive(len(excluded))
        notes.append(f"{len(excluded)} more did not fit your budget or rating.")
        if max_price is not None:
            b.derive(max_price)
    simpler = f"{names[0]} is the best match." if len(shown) > 1 else None
    return b.checked(
        subjects,
        summary,
        simpler=simpler,
        followups=["Why?", "Open the first one", "Add the first one to cart"],
        warnings=notes,
    )


def budget_text(max_price: float | None) -> str:
    return money(max_price, "INR") if max_price is not None else ""
