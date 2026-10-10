import logging

from fastapi import APIRouter

from app.brain.orchestrator import NoRecording, handle_turn
from app.mocks import fixture
from app.models import TurnRequest, TurnResponse

router = APIRouter()
log = logging.getLogger(__name__)


# MOCK=1 runs the real orchestrator with recorded LLM responses (fixtures/llm/turn/); an
# utterance with no recording gets the canned fixtures/mocks/TurnResponse.json as before.
@router.post("/turn", response_model=TurnResponse, response_model_exclude_unset=True)
async def turn(req: TurnRequest) -> TurnResponse:
    try:
        return await handle_turn(req)
    except NoRecording as exc:
        log.info("no recorded LLM response, serving the canned TurnResponse: %s", exc)
        return fixture(TurnResponse)
