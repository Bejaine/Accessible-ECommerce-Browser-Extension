"""Reviews -> pros, cons, verdict with mention counts (Track C). STUB."""

from __future__ import annotations

from app.errors import not_implemented
from app.models import AccessibleOutput, ReviewsSummarizeRequest


async def summarise(_req: ReviewsSummarizeRequest) -> AccessibleOutput:
    raise not_implemented("Review summaries")
