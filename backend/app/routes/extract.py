from fastapi import APIRouter

from app.brain.extract import extract as extract_fields
from app.brain.llm import LLMError
from app.config import get_settings
from app.errors import ApiError
from app.mocks import fixture
from app.models import ErrorCode, ExtractFallbackRequest, ExtractFallbackResponse

router = APIRouter(prefix="/extract")


@router.post("/fallback", response_model=ExtractFallbackResponse, response_model_exclude_unset=True)
async def fallback(req: ExtractFallbackRequest) -> ExtractFallbackResponse:
    try:
        return await extract_fields(req)
    except LLMError as exc:
        if get_settings().mock:  # no recording for this page: the canned fixture
            return fixture(ExtractFallbackResponse)
        raise ApiError(
            ErrorCode.upstream_unavailable,
            "I couldn't read more details from this page right now.",
            status=503,
            retryable=True,
        ) from exc
