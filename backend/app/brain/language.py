"""Translation for /turn, through Track A's gateway only (rule 6) with masking (rule 7).

Uses `bhashini.translate(text, src, tgt)` once Track A adds it (requested in docs/STATUS.md).
Until then, or when it fails, `translate` returns None and the caller keeps English and says so
by setting `lang: en`, never pretending a text is translated.
"""

from __future__ import annotations

import logging

from app.errors import ApiError
from app.services import bhashini, masking

log = logging.getLogger(__name__)


async def translate(text: str, src: str, tgt: str) -> str | None:
    if src == tgt or not text.strip():
        return text
    gateway = getattr(bhashini, "translate", None)
    if gateway is None:
        return None
    masked, table = masking.mask(text)
    try:
        out = await gateway(masked, src, tgt)
    except ApiError as exc:
        log.warning("translation %s->%s failed: %s", src, tgt, exc.message)
        return None
    return masking.unmask(out, table) if out else None
