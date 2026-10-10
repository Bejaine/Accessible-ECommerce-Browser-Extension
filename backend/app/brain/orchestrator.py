"""/turn orchestrator (Track C). STUB: real mode is not implemented; MOCK serves a fixture."""

from __future__ import annotations

from app.errors import not_implemented
from app.models import TurnRequest, TurnResponse


async def handle_turn(_req: TurnRequest) -> TurnResponse:
    raise not_implemented("Conversation")
