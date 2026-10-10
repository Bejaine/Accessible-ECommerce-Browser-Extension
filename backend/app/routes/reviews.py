from fastapi import APIRouter

from app.brain.review_summariser import summarise
from app.config import get_settings
from app.mocks import fixture
from app.models import AccessibleOutput, ReviewsSummarizeRequest

router = APIRouter(prefix="/reviews")


@router.post("/summarize", response_model=AccessibleOutput, response_model_exclude_unset=True)
async def summarize(req: ReviewsSummarizeRequest) -> AccessibleOutput:
    if get_settings().mock:
        return fixture(AccessibleOutput)
    return await summarise(req)
