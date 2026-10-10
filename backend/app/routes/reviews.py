from fastapi import APIRouter

from app.brain.review_summariser import summarise
from app.models import AccessibleOutput, ReviewsSummarizeRequest

router = APIRouter(prefix="/reviews")


# No MOCK branch: the summary is built from the ProductJSON in the request only.
@router.post("/summarize", response_model=AccessibleOutput, response_model_exclude_unset=True)
async def summarize(req: ReviewsSummarizeRequest) -> AccessibleOutput:
    return await summarise(req)
