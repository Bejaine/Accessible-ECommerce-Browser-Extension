"""Fewer choices for `prefs.verbosity == "short"` or `prefs.lite_mode` (docs/conditions.md:
older users get at most 3 options per step; CLAUDE.md: lite mode gives shorter answers).

Applied per response, after grounding and before translation (fewer lines to translate too).
The summary is never cut: it is already at most two short sentences, and cutting it lost the
facts that matter ("Expected delivery: 12 October", "check your microphone", read-backs).
Only whole lines are dropped, never rewritten, so every kept claim keeps its grounding.
"""

from __future__ import annotations

from app.models import AccessibleOutput

MAX_ITEMS = 3
MAX_FOLLOWUPS = 3
MAX_TABLE_ROWS = 4


def wants_short(prefs) -> bool:
    verbosity = getattr(prefs.verbosity, "value", prefs.verbosity)
    return verbosity == "short" or bool(prefs.lite_mode)


def shorten(output: AccessibleOutput) -> AccessibleOutput:
    data = output.model_dump(mode="json")
    for section in data["sections"]:
        section["items"] = section["items"][:MAX_ITEMS]
        if section["table"]:
            section["table"]["rows"] = section["table"]["rows"][:MAX_TABLE_ROWS]
    data["followups"] = data["followups"][:MAX_FOLLOWUPS]
    return AccessibleOutput.model_validate(data)
