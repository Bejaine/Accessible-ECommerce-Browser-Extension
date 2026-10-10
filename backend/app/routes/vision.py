from fastapi import APIRouter

from app.brain.llm import LLMError
from app.brain.vision import describe as describe_image
from app.config import get_settings
from app.errors import ApiError
from app.mocks import fixture
from app.models import ErrorCode, VisionDescribeRequest, VisionDescribeResponse

router = APIRouter(prefix="/vision")


@router.post("/describe", response_model=VisionDescribeResponse, response_model_exclude_unset=True)
async def describe(req: VisionDescribeRequest) -> VisionDescribeResponse:
    try:
        return await describe_image(req)
    except LLMError as exc:
        if get_settings().mock:  # no recording for this URL: the canned fixture, as before
            return fixture(VisionDescribeResponse)
        raise ApiError(
            ErrorCode.upstream_unavailable,
            "I can't describe that photo right now.",
            status=503,
            retryable=True,
        ) from exc
