from fastapi import APIRouter

from app.config import get_settings
from app.errors import not_implemented
from app.mocks import fixture
from app.models import ProductPrepareRequest, ProductPrepareResponse

router = APIRouter()


@router.post(
    "/product/prepare", response_model=ProductPrepareResponse, response_model_exclude_unset=True
)
async def prepare(_req: ProductPrepareRequest) -> ProductPrepareResponse:
    if get_settings().mock:
        return fixture(ProductPrepareResponse)
    raise not_implemented("Product preparation")
