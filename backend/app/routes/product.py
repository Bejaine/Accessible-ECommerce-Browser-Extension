from fastapi import APIRouter

from app.brain.prepare import prepare as prepare_product
from app.models import ProductPrepareRequest, ProductPrepareResponse

router = APIRouter()


# No MOCK branch: preparation reads only the ProductJSON in the request (no LLM, SerpApi or
# language API yet), so mock and real mode give the same, grounding-checked result.
@router.post(
    "/product/prepare", response_model=ProductPrepareResponse, response_model_exclude_unset=True
)
async def prepare(req: ProductPrepareRequest) -> ProductPrepareResponse:
    return await prepare_product(req)
