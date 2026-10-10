from fastapi import APIRouter

from app.config import get_settings
from app.errors import not_implemented
from app.mocks import fixture
from app.models import TranslateRequest, TranslateResponse

router = APIRouter()


@router.post("/translate", response_model=TranslateResponse, response_model_exclude_unset=True)
async def translate(_req: TranslateRequest) -> TranslateResponse:
    if get_settings().mock:
        return fixture(TranslateResponse)
    raise not_implemented("Translation")
