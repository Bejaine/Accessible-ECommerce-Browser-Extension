from fastapi import APIRouter

from app import __version__
from app.config import get_settings
from app.models import SCHEMA_VERSION, HealthResponse

router = APIRouter()


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        schema_version=SCHEMA_VERSION, status="ok", mock=get_settings().mock, version=__version__
    )
