"""Translation for /turn, through Track A's gateway only (rule 6) with masking (rule 7).

Uses `bhashini.translate(text, src, tgt)` once Track A adds it (requested in docs/STATUS.md).
Until then, or when it fails, `translate` returns None and the caller keeps English and says so
by setting `lang: en`, never pretending a text is translated.
"""

from __future__ import annotations

import logging
import re
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
    return _restore_colons(text, masking.unmask(out, table))


# MT renders "Colour: Midnight Black" as "रंगः ..." (Devanagari visarga) or the Telugu visarga.
_VISARGA_BEFORE_SPACE = re.compile(r"[\u0903\u0c03](?=\s)")


def _restore_colons(source: str, out: str) -> str:
    """Put back the colons MT turned into visargas, never more than the source had (the
    visarga is also a real letter in some words)."""
    budget = source.count(":")
    if not budget:
        return out
    return _VISARGA_BEFORE_SPACE.sub(":", out, count=budget)
