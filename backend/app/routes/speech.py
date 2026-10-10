from fastapi import APIRouter

from app.models import SCHEMA_VERSION, AsrMeta, ASRRequest, ASRResponse, TTSRequest, TTSResponse
from app.services import bhashini

router = APIRouter(prefix="/speech")


@router.post("/asr", response_model=ASRResponse, response_model_exclude_unset=True)
async def asr(req: ASRRequest) -> ASRResponse:
    result = await bhashini.asr(
        req.lang.value, audio_base64=req.audio_base64, encoding=req.encoding.value
    )
    return ASRResponse(
        schema_version=SCHEMA_VERSION,
        text=result.text,
        lang=req.lang,
        asr_meta=AsrMeta(
            confidence=result.confidence,
            mic_level=req.mic_level,  # our own level, so silence and unclear speech differ
            alternatives=result.alternatives,
        ),
    )


@router.post("/tts", response_model=TTSResponse, response_model_exclude_unset=True)
async def tts(req: TTSRequest) -> TTSResponse:
    result = await bhashini.tts(req.text, req.lang.value, voice=req.voice)
    return TTSResponse(
        schema_version=SCHEMA_VERSION,
        audio_base64=result.audio_base64,
        encoding=result.encoding,
        lang=req.lang,
        cached=result.cached,
    )
