"""Translation for /turn, through Track A's gateway only (rule 6) with masking (rule 7).

Uses `bhashini.translate(text, src, tgt)` once Track A adds it (requested in docs/STATUS.md).
Until then, or when it fails, `translate` returns None and the caller keeps English and says so
by setting `lang: en`, never pretending a text is translated.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable

from app.errors import ApiError
from app.services import bhashini, masking

log = logging.getLogger(__name__)


async def translate(text: str, src: str, tgt: str, keep: Iterable[str] = ()) -> str | None:
    """`keep`: product brands, so everyday-word brands ("Apple", "Noise") stay untranslated."""
    if src == tgt or not text.strip():
        return text
    gateway = getattr(bhashini, "translate", None)
    if gateway is None:
        return None
    masked, table = masking.mask(text, keep=[k for k in keep if k])
    try:
        out = await gateway(masked, src, tgt)
    except ApiError as exc:
        log.warning("translation %s->%s failed: %s", src, tgt, exc.message)
        return None
    if not out:
        return None
    lost = masking.missing(out, table)
    if lost:
        # A dropped placeholder would lose a name or a price from what the user hears.
        log.warning("translation %s->%s lost %s; keeping %s", src, tgt, lost, src)
        return None
    return masking.unmask(out, table)
