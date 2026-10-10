from fastapi import APIRouter

from app.brain.orchestrator import handle_turn
from app.config import get_settings
from app.mocks import fixture
from app.models import TurnRequest, TurnResponse

router = APIRouter()


@router.post("/turn", response_model=TurnResponse, response_model_exclude_unset=True)
async def turn(req: TurnRequest) -> TurnResponse:
    if get_settings().mock:
        return fixture(TurnResponse)
    return await handle_turn(req)
