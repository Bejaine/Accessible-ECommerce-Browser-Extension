from fastapi import APIRouter

from app.config import get_settings
from app.errors import not_implemented
from app.mocks import fixture
from app.models import OCRRequest, OCRResponse

router = APIRouter()


@router.post("/ocr", response_model=OCRResponse, response_model_exclude_unset=True)
async def ocr(_req: OCRRequest) -> OCRResponse:
    if get_settings().mock:
        return fixture(OCRResponse)
    raise not_implemented("Reading text from images")
