"""Translation for /turn, through Track A's gateway only (rule 6) with masking (rule 7).

Uses `bhashini.translate(text, src, tgt)` once Track A adds it (requested in docs/STATUS.md).
Until then, or when it fails, `translate` returns None and the caller keeps English and says so
by setting `lang: en`, never pretending a text is translated.
"""

from __future__ import annotations

import asyncio
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


MAX_CONCURRENT = 4  # Track A: each MT model allows a burst of 12, then ~0.8/s; 20 at once failed


async def translate_many(
    texts: list[str], src: str, tgt: str, keep: Iterable[str] = ()
) -> list[str] | None:
    """Translate the lines of one answer; None if any line can't be translated (the caller then
    keeps the whole answer in English). Each distinct line is translated once. Uses Track A's
    `bhashini.translate_many` (packs lines into a few requests) when it exists, otherwise at most
    MAX_CONCURRENT single requests at a time."""
    if src == tgt:
        return list(texts)
    unique = list(dict.fromkeys(t for t in texts if t.strip()))
    keep = [k for k in keep if k]
    packed = getattr(bhashini, "translate_many", None)
    if packed is not None:
        done = await _packed(packed, unique, src, tgt, keep)
    else:
        limit = asyncio.Semaphore(MAX_CONCURRENT)

        async def one(text: str) -> str | None:
            async with limit:
                return await translate(text, src, tgt, keep=keep)

        done = dict(zip(unique, await asyncio.gather(*(one(t) for t in unique)), strict=True))
    if done is None or any(v is None for v in done.values()):
        return None
    return [done.get(t, t) for t in texts]


async def _packed(gateway, lines: list[str], src: str, tgt: str, keep: list[str]):
    masked = [masking.mask(line, keep=keep) for line in lines]
    try:
        outs = await gateway([m for m, _ in masked], src, tgt)
    except ApiError as exc:
        log.warning("translation %s->%s failed: %s", src, tgt, exc.message)
        return None
    if not outs or len(outs) != len(lines):
        return None
    result = {}
    for line, (_, table), out in zip(lines, masked, outs, strict=True):
        if not out or masking.missing(out, table):
            log.warning("translation %s->%s lost a placeholder in %r", src, tgt, line[:40])
            return None
        result[line] = _restore_colons(line, masking.unmask(out, table))
    return result


# MT renders "Colour: Midnight Black" as "रंगः ..." (Devanagari visarga) or the Telugu visarga.
_VISARGA_BEFORE_SPACE = re.compile(r"[\u0903\u0c03](?=\s)")


def _restore_colons(source: str, out: str) -> str:
    """Put back the colons MT turned into visargas, never more than the source had (the
    visarga is also a real letter in some words)."""
    budget = source.count(":")
    if not budget:
        return out
    return _VISARGA_BEFORE_SPACE.sub(":", out, count=budget)
