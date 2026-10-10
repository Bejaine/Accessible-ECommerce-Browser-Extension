"""Product image descriptions via VLM, cached by image URL (Track C). STUB."""

from __future__ import annotations

from app.errors import not_implemented
from app.models import VisionDescribeRequest, VisionDescribeResponse


async def describe(_req: VisionDescribeRequest) -> VisionDescribeResponse:
    raise not_implemented("Image descriptions")
