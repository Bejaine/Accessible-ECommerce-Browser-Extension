from fastapi import APIRouter

from app.models import SCHEMA_VERSION, OCRRequest, OCRResponse
from app.services import bhashini

router = APIRouter()


@router.post("/ocr", response_model=OCRResponse, response_model_exclude_unset=True)
async def ocr(req: OCRRequest) -> OCRResponse:
    body = req.root  # the generated model doesn't enforce "exactly one"; the gateway does
    text = await bhashini.ocr(
        body.lang.value, image_url=body.image_url, image_base64=body.image_base64
    )
    return OCRResponse(schema_version=SCHEMA_VERSION, text=text, lang=body.lang)
