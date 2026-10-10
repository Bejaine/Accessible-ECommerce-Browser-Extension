"""Plain functions exposed to the LLM via function calling (Track C). STUB: none yet."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

TOOLS: dict[str, Callable[..., Any]] = {}
