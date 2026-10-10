from fastapi import APIRouter

from app.config import get_settings
from app.errors import not_implemented
from app.mocks import fixture
from app.models import ASRRequest, ASRResponse, TTSRequest, TTSResponse

router = APIRouter(prefix="/speech")


@router.post("/asr", response_model=ASRResponse, response_model_exclude_unset=True)
async def asr(_req: ASRRequest) -> ASRResponse:
    if get_settings().mock:
        return fixture(ASRResponse)
    raise not_implemented("Speech recognition")


@router.post("/tts", response_model=TTSResponse, response_model_exclude_unset=True)
async def tts(_req: TTSRequest) -> TTSResponse:
    if get_settings().mock:
        return fixture(TTSResponse)
    raise not_implemented("Speech output")
