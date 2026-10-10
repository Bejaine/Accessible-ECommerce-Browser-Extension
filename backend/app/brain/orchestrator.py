"""/turn orchestrator (Track C): one LLM call with function calling, then plain tools.

Flow: secure-zone stop -> direct paths without an LLM (tapped target, phrase chip) -> translate
the user's words to English (Track A's gateway) -> redact -> ONE Groq tool call that returns a
tool, its arguments, a confidence and up to two alternatives -> decide by confidence
(>= 0.8 act, 0.5-0.8 "Did you mean X or Y?", < 0.5 phrase chips; two misses in a row -> chips)
-> run the tool (answers are grounded; consequential actions only inside a Confirmation)
-> translate the output back. A tool may make at most one more LLM call (a section summary),
so a turn never makes more than two.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from app.brain import intent, language, tools
from app.brain.llm import LLMError, LLMSettings, complete_tool_call
from app.brain.output import plain_output
from app.brain.redact import redact
from app.config import get_settings
from app.errors import ApiError
from app.models import SCHEMA_VERSION, AccessibleOutput, ErrorCode, TurnRequest, TurnResponse
from app.services.cache import TTLCache

log = logging.getLogger(__name__)

MAX_TARGETS = 60
_sessions = TTLCache(ttl_seconds=1800)  # session_id -> consecutive misses

SYSTEM_PROMPT = """\
You route ONE shopper utterance to exactly ONE tool. The shopper may be blind, elderly, have a \
hand tremor or unclear speech (dysarthria), and may speak English, Hindi, Telugu or a mix \
(e.g. "isse cart mein daal do" = add this to the cart).

Rules:
- Call exactly one tool. Use only product ids and target ids that appear in PAGE.
- Never answer from your own knowledge; tools read the page.
- On a product page, "this", "it", "isse", "idi" mean that product.
- Use ASR alternatives and the recent history to repair misheard words.
- confidence = your probability that the tool and arguments are what the shopper meant: \
0.8 or more only when it is clear; 0.5-0.8 when plausible but you are unsure; below 0.5 when \
guessing. Give up to 2 alternatives (other plausible meanings), most likely first.
- If nothing fits, call unclear.
"""


class NoRecording(Exception):
    """MOCK=1 and no recorded LLM response for this utterance (route serves the fixture)."""


def _misses(session_id: str) -> int:
    return _sessions.get(session_id) or 0


def _set_misses(session_id: str, n: int) -> None:
    _sessions.set(session_id, n)


def page_brief(req: TurnRequest) -> dict[str, Any]:
    """What the model needs to choose a tool: ids, labels, a few facts. Not whole products."""
    page = req.page
    products = []
    for p in page.products[:20]:
        products.append(
            {
                "id": p.id,
                "title": (p.title or "")[:80],
                "price": p.price.amount if p.price else None,
                "rating": p.rating.value if p.rating else None,
                "sponsored": p.sponsored,
                "spec_keys": list(p.specs)[:30],
                "variants": [
                    {
                        "name": v.name,
                        "value": v.value,
                        "selected": v.selected,
                        "target_id": v.target_id,
                    }
                    for v in (p.variants or [])[:12]
                ],
            }
        )
    order = {"product": 0, "results": 1, "cart": 2, "search": 3}
    targets = sorted(page.targets, key=lambda t: order.get(t.zone.value, 9))[:MAX_TARGETS]
    return {
        "page_type": page.page_type.value,
        "site": page.site,
        "products": products,
        "orders": [{"id": o.id, "status": o.status} for o in page.orders],
        "targets": [
            {"id": t.id, "kind": t.kind.value, "label": t.label[:60], "zone": t.zone.value}
            for t in targets
        ],
    }


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")[:60] or "empty"


async def handle_turn(req: TurnRequest) -> TurnResponse:
    if req.page.secure_zone_active:
        raise ApiError(
            ErrorCode.secure_zone,
            "Listening is paused while you are in a payment or password field.",
            status=423,
        )
    ctx = tools.Context(req)
    user_lang = req.input.lang.value

    # Direct paths: no LLM needed.
    if req.input.target_id:
        result = await _run(ctx, "press", {"target_id": req.input.target_id})
        return await _respond(req, ctx, "press", 1.0, [], result)
    chip = (req.input.phrase_id or "").lower() or (req.input.text or "").strip().lower()
    if req.input.kind.value == "phrase" and chip in tools.CHIPS:
        name, args = tools.CHIPS[chip]
        return await _respond(req, ctx, name, 1.0, [], await _run(ctx, name, args))

    text = (req.input.text or "").strip()
    if not text:
        raise ApiError(ErrorCode.validation, "There was nothing to understand.", status=400)
    english = await language.translate(text, user_lang, "en") or text
    said = redact(english).text
    alternatives = [
        redact(a).text for a in (req.input.asr_meta.alternatives if req.input.asr_meta else [])
    ]
    history = [{"role": h.role.value, "text": redact(h.text).text} for h in req.history[-6:]]

    payload = {
        "utterance": said,
        "asr_alternatives": alternatives[:3],
        "asr_confidence": req.input.asr_meta.confidence if req.input.asr_meta else None,
        "history": history,
        "PAGE": page_brief(req),
    }
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))},
    ]
    cfg = LLMSettings.load()
    try:
        name, args = await complete_tool_call(
            f"turn/{_slug(said)}", [cfg.model, cfg.fast_model], messages, tools.TOOL_SPECS
        )
    except LLMError as exc:
        if get_settings().mock:
            raise NoRecording(str(exc)) from exc
        raise ApiError(
            ErrorCode.upstream_unavailable,
            "I couldn't understand that right now. Please try again, or choose an option.",
            status=503,
            retryable=True,
        ) from exc

    confidence = _confidence(args.get("confidence"))
    alts = tools.parse_alternatives(args.get("alternatives"))
    decision = intent.decision(confidence)
    if name == "unclear":
        decision = "chips"
    misses = _misses(req.session_id)
    if decision != "act" and misses + 1 >= 2:
        decision = "chips"  # never ask a third time

    if decision == "act":
        try:
            result = await _run(ctx, name, args)
        except tools.ToolInputError as exc:
            log.info("tool %s rejected: %s", name, exc)
            decision, confidence = "chips", min(confidence, 0.4)
        else:
            _set_misses(req.session_id, 0)
            return await _respond(req, ctx, name, confidence, alts, result)

    _set_misses(req.session_id, misses + 1)
    if decision == "ask":
        return await _ask(req, ctx, name, args, confidence, alts)
    chips = tools.phrase_chips(ctx)
    summary = (
        "Sorry, I didn't catch that. You can choose one of these."
        if misses
        else "I didn't catch that."
    )
    result = tools.ToolResult("Not sure", plain_output(summary, followups=chips))
    return await _respond(req, ctx, "unclear", min(confidence, 0.49), [], result)


def _confidence(value: Any) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


async def _run(ctx: tools.Context, name: str, args: dict[str, Any]) -> tools.ToolResult:
    result = await tools.run(ctx, name, args)
    for reason in result.dropped:
        log.warning("grounding dropped (/turn %s): %s", name, reason)
    return result


async def _ask(
    req: TurnRequest,
    ctx: tools.Context,
    name: str,
    args: dict[str, Any],
    confidence: float,
    alts: list[tuple[str, str, dict[str, Any]]],
) -> TurnResponse:
    """0.5-0.8: never act; offer the top two meanings. Each choice carries its actions only if
    they are safe to run directly; consequential ones are confirmed on the next turn."""
    options: list[dict[str, Any]] = []
    for tool_name, tool_args in [(name, args), *[(t, a) for _, t, a in alts]]:
        if tool_name in tools.READ_TOOLS:
            # Reading needs no page action; don't run it (it may cost an LLM call).
            options.append(
                {"label": tools.label_for(tool_name, tool_args), "intent": tool_name, "actions": []}
            )
        else:
            try:
                result = await tools.run(ctx, tool_name, tool_args)
            except tools.ToolInputError:
                continue
            safe = result.confirmation is None
            actions = result.actions if safe else []
            options.append({"label": result.label, "intent": tool_name, "actions": actions})
        if len(options) == 2:
            break
    if not options:
        output = plain_output("I didn't catch that.", followups=tools.phrase_chips(ctx))
    elif len(options) == 1:
        output = plain_output(f"Did you mean: {options[0]['label']}?", followups=["Yes", "No"])
    else:
        labels = [o["label"] for o in options]
        output = plain_output(f"Did you mean {labels[0]}, or {labels[1]}?", followups=labels)
    output = await _translate_output(output, req.input.lang.value)
    return TurnResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "intent": {"name": name, "confidence": confidence, "alternatives": options},
            "actions": [],
            "confirmation": None,
            "workflow": None,
            "output": output,
        }
    )


async def _respond(
    req: TurnRequest,
    ctx: tools.Context,
    name: str,
    confidence: float,
    alts: list[tuple[str, str, dict[str, Any]]],
    result: tools.ToolResult,
) -> TurnResponse:
    lang = req.input.lang.value
    output = await _translate_output(result.output, lang)
    confirmation = result.confirmation
    if confirmation is not None:
        confirmation = {**confirmation, "prompt": output.summary}
    alternatives = [{"label": label, "intent": tool, "actions": []} for label, tool, _ in alts]
    return TurnResponse.model_validate(
        {
            "schema_version": SCHEMA_VERSION,
            "intent": {"name": name, "confidence": confidence, "alternatives": alternatives},
            # Consequential actions are only ever inside the confirmation (rule 3).
            "actions": [] if confirmation else result.actions,
            "confirmation": confirmation,
            "workflow": None,
            "output": output,
        }
    )


async def _translate_output(output: AccessibleOutput, lang: str) -> AccessibleOutput:
    """Translate what the user hears/reads; keep English (lang en) if translation fails."""
    if lang == "en":
        return output
    data = output.model_dump(mode="json")
    texts: list[tuple[Any, Any]] = []  # (container, key)
    texts.append((data, "summary"))
    if data["simpler"]:
        texts.append((data, "simpler"))
    for i in range(len(data["followups"])):
        texts.append((data["followups"], i))
    for i in range(len(data["warnings"])):
        texts.append((data["warnings"], i))
    for section in data["sections"]:
        texts.append((section, "heading"))
        for item in section["items"]:
            texts.append((item, "text"))
        if section["table"]:
            texts.append((section["table"], "spoken"))
    translated = []
    for container, key in texts:
        out = await language.translate(container[key], "en", lang)
        if out is None:
            return output  # all or nothing: never a half-translated answer
        translated.append((container, key, out))
    for container, key, out in translated:
        container[key] = out
    data["lang"] = lang
    return AccessibleOutput.model_validate(data)
