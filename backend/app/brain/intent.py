"""LLM intent repair for unclear speech (Track C). STUB.

Thresholds from docs/conditions.md: >= 0.8 act, 0.5-0.8 ask "X or Y?", < 0.5 phrase chips.
"""

from __future__ import annotations

from typing import Literal

ACT = 0.8
ASK = 0.5


def decision(confidence: float) -> Literal["act", "ask", "chips"]:
    if confidence >= ACT:
        return "act"
    if confidence >= ASK:
        return "ask"
    return "chips"
