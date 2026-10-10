from fastapi import APIRouter

from app.models import SCHEMA_VERSION, TranslateRequest, TranslateResponse
from app.services import bhashini, masking

router = APIRouter()


@router.post("/translate", response_model=TranslateResponse, response_model_exclude_unset=True)
async def translate(req: TranslateRequest) -> TranslateResponse:
    # Rule 7: brands, model names, units and prices never reach the MT model.
    masked, table = masking.mask(req.text)
    out = await bhashini.translate(masked, req.source_lang.value, req.target_lang.value)
    return TranslateResponse(
        schema_version=SCHEMA_VERSION,
        text=masking.unmask(out, table),
        source_lang=req.source_lang,
        target_lang=req.target_lang,
    )
