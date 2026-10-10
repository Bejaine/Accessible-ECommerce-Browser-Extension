from fastapi import APIRouter

from app.brain.vision import describe as describe_image
from app.config import get_settings
from app.mocks import fixture
from app.models import VisionDescribeRequest, VisionDescribeResponse

router = APIRouter(prefix="/vision")


@router.post("/describe", response_model=VisionDescribeResponse, response_model_exclude_unset=True)
async def describe(req: VisionDescribeRequest) -> VisionDescribeResponse:
    if get_settings().mock:
        return fixture(VisionDescribeResponse)
    return await describe_image(req)
