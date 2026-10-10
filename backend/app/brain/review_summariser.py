"""Reviews -> pros, cons, verdict with mention counts (Track C).

Built only from ProductJSON.reviews (the page's "Customers say" summary, insights with mention
counts, the star histogram and the visible review items). The summary says what it is based on
and never claims more reviews than `basis_count`.
"""

from __future__ import annotations

from app.brain.format import join_words, number
from app.brain.grounding import CheckResult
from app.brain.output import OutputBuilder
from app.brain.sections import _fit, rating_sentence
from app.models import AccessibleOutput, ProductJSON, ReviewsSummarizeRequest

SAMPLE_REVIEWS = 3
FOLLOWUPS = ["Read a review", "Tell me the specs", "Add to cart"]


async def summarise(req: ReviewsSummarizeRequest) -> AccessibleOutput:
    return (await summarise_product(req.product)).output


async def summarise_product(p: ProductJSON) -> CheckResult:
    b = OutputBuilder(p.id)
    subjects = {p.id: p}
    r = p.reviews
    if r is None:
        return b.checked(
            subjects,
            _fit("The page doesn't show any reviews for this product.", rating_sentence(b, p)),
            followups=["Tell me the specs", "Add to cart"],
        )

    def by_mentions(sentiment: str) -> list[tuple[int, object]]:
        found = [(i, x) for i, x in enumerate(r.insights) if x.sentiment.value == sentiment]
        return sorted(found, key=lambda pair: -pair[1].mentions.total)

    pros, cons, mixed = by_mentions("positive"), by_mentions("negative"), by_mentions("mixed")
    for heading, kind, group in (("Pros", "pro", pros), ("Cons", "con", cons + mixed)):
        items = []
        for i, x in group:
            m = x.mentions
            if x.sentiment.value == "mixed":
                text = f"{x.topic}: opinions are mixed ({number(m.total)} mentions)"
                claim = number(m.total)
            elif kind == "pro":
                text = f"{x.topic}: {number(m.positive)} of {number(m.total)} mentions are positive"
                claim = f"{number(m.positive)} of {number(m.total)}"
            else:
                text = f"{x.topic}: {number(m.negative)} of {number(m.total)} mentions are negative"
                claim = f"{number(m.negative)} of {number(m.total)}"
            items.append(b.item(text, kind, claim=claim, path=f"reviews.insights[{i}].mentions"))
        if items:
            b.section(heading, items)

    if r.summary_text:
        b.section(
            "The page's own summary",
            [b.item(r.summary_text, claim=r.summary_text, path="reviews.summary_text")],
        )
    if r.histogram is not None:
        b.derive(1, 2, 3, 4, 5)
        stars = r.histogram.model_dump(by_alias=True)
        rows = [
            b.item(
                f"{s} star{'s' if s > 1 else ''}: {number(stars[str(s)])} ratings",
                "row",
                claim=number(stars[str(s)]),
                path=f"reviews.histogram.{s}",
            )
            for s in (5, 4, 3, 2, 1)
        ]
        b.section("Star ratings", rows)
    if r.items:
        b.section(
            "Some reviews",
            [
                b.item(_review_text(item), claim=item.text, path=f"reviews.items[{i}]")
                for i, item in enumerate(r.items[:SAMPLE_REVIEWS])
            ],
        )

    basis = number(r.basis_count)
    if r.basis_count:
        b.ground(f"{basis} reviews", "reviews.basis_count")
    lead = f"Based on {basis} reviews" if r.basis_count else "Based on the reviews shown"
    liked = [x.topic.lower() for _, x in pros[:2]]
    disliked = [x.topic.lower() for _, x in cons[:1]]
    if liked:
        first = f"{lead}, people like the {join_words(liked)}."
    elif r.summary_text:
        first = f"{lead}: {r.summary_text.split('. ')[0].rstrip('.')}."
    elif r.items:
        b.derive(len(r.items))
        first = f"The page shows {len(r.items)} reviews but no summary of them."
    else:
        first = "The page doesn't show any reviews yet."
    if disliked:
        second = f"The main complaint is the {disliked[0]}."
    elif mixed:
        second = f"Opinions on {mixed[0][1].topic.lower()} are mixed."
    else:
        second = ""
    simpler = f"Most buyers like the {liked[0]}." if liked else None
    return b.checked(
        subjects,
        _fit(first, second) if second else first,
        simpler=simpler,
        followups=FOLLOWUPS,
    )


def _review_text(item) -> str:
    stars = f"{number(item.rating)} stars. " if item.rating is not None else ""
    title = f"{item.title}. " if item.title else ""
    return f"{stars}{title}{item.text}"
