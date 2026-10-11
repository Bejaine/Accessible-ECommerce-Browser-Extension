"""/turn tools and the paths that need no LLM: safety rules first."""

import asyncio
import json

import pytest

from app.brain import orchestrator, session, tools
from app.brain.grounding import check
from app.errors import ApiError
from app.models import TurnRequest


@pytest.fixture
def req(mock_body) -> TurnRequest:
    return TurnRequest.model_validate(mock_body("TurnRequest"))


@pytest.fixture
def search_req(mock_body) -> TurnRequest:
    data = mock_body("TurnRequest")
    data["page"] = mock_body("PageContext.search")
    return TurnRequest.model_validate(data)


def run(coro):
    return asyncio.run(coro)


def with_input(req: TurnRequest, **changes) -> TurnRequest:
    data = req.model_dump(mode="json", by_alias=True)
    data["input"].update(changes)
    return TurnRequest.model_validate(data)


# --- consequential actions only through a Confirmation ---


def test_add_to_cart_is_a_confirmation_with_read_back(req):
    ctx = tools.Context(req)
    result = run(tools.add_to_cart(ctx, quantity=2))
    assert result.actions == []
    conf = result.confirmation
    assert [(a["type"], a["target_id"], a["value"]) for a in conf["pending_actions"]] == [
        ("select", "t-qty", "2"),
        ("click", "t-add-to-cart", None),
    ]
    assert conf["read_back"] == {
        "quantity": 2,
        "total": {"amount": 35998.0, "currency": "INR"},
        "pin_code": None,
    }
    assert result.output.summary == "Add Zentra Pulse 5G to your cart? Quantity 2, total ₹35,998."
    assert [i.text for i in result.output.sections[0].items] == ["Colour: Midnight Black"]
    assert conf["pending_actions"][-1]["expected_effect"]["kind"] == "cart_count_increase"


@pytest.mark.parametrize("label", ["Buy Now", "Place your order", "Pay ₹17,999"])
def test_buy_and_pay_buttons_are_never_pressed(req, label):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["targets"][-2]["label"] = label  # t-buy-now
    target = data["page"]["targets"][-2]["id"]
    ctx = tools.Context(TurnRequest.model_validate(data))
    result = run(tools.press(ctx, target))
    assert result.actions == [] and result.confirmation is None
    assert "won't press" in result.output.summary


def test_turn_never_lists_pending_actions_as_actions(req):
    response = run(
        orchestrator.handle_turn(with_input(req, kind="switch", target_id="t-add-to-cart"))
    )
    assert response.actions == []
    assert response.confirmation is not None
    assert response.confirmation.pending_actions[0].target_id == "t-add-to-cart"


def test_risky_buttons_need_high_risk_confirmation(req):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["targets"][-2]["label"] = "Cancel items"
    ctx = tools.Context(TurnRequest.model_validate(data))
    result = run(tools.press(ctx, data["page"]["targets"][-2]["id"]))
    assert result.confirmation["risk"] == "high"
    assert result.actions == []


# --- safe actions run directly ---


def test_choosing_a_colour_is_a_direct_action(req):
    result = run(tools.press(tools.Context(req), "t-swatch-green"))
    assert [(a["type"], a["target_id"]) for a in result.actions] == [("click", "t-swatch-green")]
    assert result.actions[0]["expected_effect"]["kind"] == "value_set"
    assert result.confirmation is None


def test_search_navigates_to_the_site_search(req):
    result = run(tools.search(tools.Context(req), "wireless earphones"))
    assert result.actions[0]["type"] == "navigate"
    assert result.actions[0]["value"] == "https://www.amazon.in/s?k=wireless+earphones"


def test_unknown_target_is_rejected(req):
    with pytest.raises(tools.ToolInputError):
        run(tools.press(tools.Context(req), "t-does-not-exist"))


# --- answers come from fields ---


def test_answer_question_finds_spec_by_topic(req):
    ctx = tools.Context(req)
    result = run(tools.answer_question(ctx, "battery capacity", field_paths=["specs.batery"]))
    assert result.output.summary == "Battery Capacity: 5000 mAh."
    p = ctx.main_product()
    assert check(result.output, {p.id: p}).dropped == []


def test_answer_question_says_when_page_does_not_list_it(req):
    result = run(tools.answer_question(tools.Context(req), "water resistance rating"))
    assert result.output.summary == "The page doesn't list water resistance rating."


@pytest.mark.parametrize(
    ("topic", "summary"),
    [
        ("price", "Price: ₹17,999."),
        ("how much", None),
        ("stock", "Availability: In stock."),
        ("delivery", "Delivery: FREE delivery Tuesday, 14 October."),
        ("star rating", "Rating: 4.2 out of 5 from 3,418 ratings."),
    ],
)
def test_answer_question_without_field_paths(req, topic, summary):
    """Seen live: the model sent only topic="price" and the answer was "not listed"."""
    ctx = tools.Context(req)
    result = run(tools.answer_question(ctx, topic))
    if summary:
        assert result.output.summary == summary
        p = ctx.main_product()
        assert check(result.output, {p.id: p}).dropped == []
        assert result.output.grounding
    else:
        assert "doesn't list" in result.output.summary, "no fields named: nothing guessed"


def test_compare_with_nothing_seen_says_what_to_do(req):
    session.reset()
    result = run(tools.compare(tools.Context(req)))
    assert result.output.summary.startswith("I don't remember another product from this visit.")


def test_a_product_only_opened_can_be_compared_later(req, mock_body):
    """Open A (only /product/prepare runs), open B, say "compare with the last one"."""
    from app.brain import prepare
    from app.models import ProductPrepareRequest

    session.reset()
    first = mock_body("ProductPrepareRequest")
    first["session_id"] = req.session_id
    first["product"]["id"] = "amazon.in:B0OPENED001"
    first["product"]["title"] = "Novix Max 5G"
    run(prepare.prepare(ProductPrepareRequest.model_validate(first)))
    result = run(tools.compare(tools.Context(req)))
    table = result.output.sections[0].table
    assert table.columns[1:] == ["Zentra Pulse 5G", "Novix Max 5G"]


def test_recommend_cheapest_skips_sponsored(search_req):
    session.reset()
    ctx = tools.Context(search_req)
    result = run(tools.recommend(ctx, prefer="cheapest"))
    table = result.output.sections[0].table
    assert table.columns == ["", "Orbita M3 5G", "Zentra Pulse 5G"]
    assert table.rows[0] == ["Price", "₹13,999", "₹17,999"]
    assert "Novix" not in json.dumps(table.model_dump()), "the sponsored listing is left out"
    assert result.output.warnings == ["Sponsored listings were left out."]


def test_compare_builds_a_grounded_table(search_req):
    ctx = tools.Context(search_req)
    ids = [p.id for p in search_req.page.products[:2]]
    result = run(tools.compare(ctx, ids))
    table = result.output.sections[0].table
    assert table.columns == ["", "Novix A15 5G", "Zentra Pulse 5G"]
    assert table.rows[0] == ["Price", "₹15,499", "₹17,999"]
    assert "not listed" not in json.dumps(table.rows)


def test_where_am_i(search_req):
    result = run(tools.where_am_i(tools.Context(search_req)))
    assert result.output.summary == "This is a search page on amazon.in. It lists 3 products."


# --- turn paths without an LLM ---


def test_secure_zone_stops_everything(req):
    data = req.model_dump(mode="json", by_alias=True)
    data["page"]["secure_zone_active"] = True
    with pytest.raises(ApiError) as err:
        run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert err.value.code.value == "secure_zone"


def test_phrase_chip_runs_without_llm(req, monkeypatch):
    async def no_llm(*_a, **_k):
        raise AssertionError("chips must not call the LLM")

    monkeypatch.setattr(orchestrator, "complete_tool_call", no_llm)
    response = run(
        orchestrator.handle_turn(with_input(req, kind="phrase", text="Price", phrase_id=None))
    )
    assert response.output.summary == "Price: ₹17,999."
    assert response.intent.confidence == 1.0


def test_page_brief_is_small_and_has_no_page_text(req):
    brief = orchestrator.page_brief(req)
    assert set(brief) == {
        "page_type",
        "site",
        "products",
        "orders",
        "targets",
        "SEEN",
        "stated_preferences",
        "TASK_IN_PROGRESS",
        "checkout",
    }
    assert "reviews" not in json.dumps(brief)


# --- translation through Track A's gateway (bhashini.translate) ---


def test_turn_answers_in_the_users_language(req, monkeypatch):
    """With Track A's gateway in place, /turn translates everything the user hears or reads;
    actions, ids and grounding stay as they are."""
    from app.services import bhashini

    calls = []

    async def fake_translate(text, source, target):
        calls.append((source, target))
        return f"[{target}] {text}"

    monkeypatch.setattr(bhashini, "translate", fake_translate)
    monkeypatch.delattr(bhashini, "translate_many", raising=False)  # test the single-line path
    response = run(
        orchestrator.handle_turn(with_input(req, kind="switch", target_id="t-add-to-cart"))
    )
    out = response.output
    assert out.lang.value == "hi"
    assert out.summary.startswith("[hi] Add Zentra Pulse 5G")
    assert all(f.startswith("[hi] ") for f in out.followups)
    assert response.confirmation.prompt == out.summary
    assert response.confirmation.pending_actions[0].target_id == "t-add-to-cart"
    assert all(not g.claim.startswith("[hi]") for g in out.grounding)
    assert set(calls) == {("en", "hi")}


def test_failed_translation_keeps_english_and_says_so(req, monkeypatch):
    from app.errors import ApiError
    from app.models import ErrorCode
    from app.services import bhashini

    async def down(text, source, target):
        raise ApiError(ErrorCode.upstream_unavailable, "MT down", status=503)

    monkeypatch.setattr(bhashini, "translate", down)
    monkeypatch.delattr(bhashini, "translate_many", raising=False)  # test the single-line path
    response = run(
        orchestrator.handle_turn(with_input(req, kind="switch", target_id="t-add-to-cart"))
    )
    assert response.output.lang.value == "en"
    assert response.output.summary.startswith("Add Zentra Pulse 5G")


# --- what Track A's ASR actually sends: no confidence, no alternatives, a mic level ---


def test_silence_is_a_mic_problem_not_unclear_speech(req):
    session.reset()
    r = run(
        orchestrator.handle_turn(
            with_input(
                req,
                kind="voice",
                text="",
                asr_meta={"confidence": None, "mic_level": 0.01, "alternatives": []},
            )
        )
    )
    assert r.output.summary.startswith("I couldn't hear anything. Please check your microphone")
    assert r.actions == [] and session.get(req.session_id).misses == 0


def test_speech_with_no_words_is_a_miss_with_chips(req):
    session.reset()
    r = run(
        orchestrator.handle_turn(
            with_input(
                req,
                kind="voice",
                text="",
                asr_meta={"confidence": None, "mic_level": 0.6, "alternatives": []},
            )
        )
    )
    assert r.output.summary.startswith("I didn't catch that.")
    # The fixture persona has verbosity "short": at most 3 options (docs/conditions.md).
    assert r.output.followups == ["Price", "Specs", "Reviews"]
    assert session.get(req.session_id).misses == 1


def test_null_asr_confidence_does_not_block(mock_body, monkeypatch):
    """Track A's ASR gives confidence null: treated as unknown, so a clear intent still acts."""
    session.reset()

    async def tool_call(*_a, **_k):
        return "press", {"target_id": "t-swatch-green", "confidence": 0.95, "alternatives": []}

    monkeypatch.setattr(orchestrator, "complete_tool_call", tool_call)
    data = mock_body("TurnRequest")
    data["input"].update(
        text="show me the green one",
        lang="en",
        asr_meta={"confidence": None, "mic_level": 0.5, "alternatives": []},
    )
    r = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert [a.target_id for a in r.actions] == ["t-swatch-green"]


# --- Track A's masking (brands kept) and number normaliser ---


def test_brands_are_kept_and_lost_placeholders_keep_english(req, monkeypatch):
    from app.brain import language
    from app.services import bhashini, masking

    seen_keep = []
    real_mask = masking.mask

    def spy_mask(text, keep=()):
        seen_keep.append(list(keep))
        return real_mask(text, keep=keep)

    async def drops_names(text, source, target):
        return "कार्ट में जोड़ें?"  # every placeholder lost

    monkeypatch.setattr(masking, "mask", spy_mask)
    monkeypatch.setattr(bhashini, "translate", drops_names)
    out = run(language.translate("Add Zentra Pulse 5G to your cart?", "en", "hi", keep=["Zentra"]))
    assert ["Zentra"] in seen_keep
    assert out is None, "a translation that lost the product name is not used"


def test_spoken_numbers_reach_the_model_as_digits(mock_body, monkeypatch):
    sent = {}

    async def tool_call(key, models, messages, tools_):
        sent["payload"] = json.loads(messages[1]["content"])
        sent["key"] = key
        return "unclear", {"confidence": 0.3, "alternatives": []}

    monkeypatch.setattr(orchestrator, "complete_tool_call", tool_call)
    data = mock_body("TurnRequest")
    data["input"].update(text="phones under fifteen thousand", lang="en")
    run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert sent["payload"]["utterance"] == "phones under 15000"
    assert sent["key"] == "turn/phones_under_fifteen_thousand", "recordings keyed by what was said"


def test_answer_strings_are_translated_in_parallel(req, monkeypatch):
    """A long answer must not cost one translation round trip per line."""
    import time

    from app.services import bhashini

    async def slow_translate(text, source, target):
        await asyncio.sleep(0.05)
        return f"[{target}] {text}"

    monkeypatch.setattr(bhashini, "translate", slow_translate)
    monkeypatch.delattr(bhashini, "translate_many", raising=False)  # test the single-line path
    ctx = tools.Context(req)
    long_answer = run(tools.read_section(ctx, "reviews")).output
    n = 1 + len(long_answer.followups) + sum(1 + len(s.items) for s in long_answer.sections)
    start = time.perf_counter()
    out = run(orchestrator._translate_output(long_answer, "hi"))
    elapsed = time.perf_counter() - start
    assert out.lang.value == "hi"
    assert n >= 10 and elapsed < 0.05 * n / 3, f"{n} strings took {elapsed:.2f}s"


# --- Track A's re-run findings ---


def test_secrets_are_redacted_before_translation(mock_body, monkeypatch):
    """docs/safety.md: redact before any text reaches an LLM *or translation*."""
    from app.services import bhashini

    sent_to_mt = []

    async def recording_translate(text, source, target):
        sent_to_mt.append(text)
        return text

    async def tool_call(*_a, **_k):
        return "unclear", {"confidence": 0.3, "alternatives": []}

    monkeypatch.setattr(bhashini, "translate", recording_translate)
    monkeypatch.setattr(orchestrator, "complete_tool_call", tool_call)
    data = mock_body("TurnRequest")
    data["input"].update(text="मेरा कार्ड 4111 1111 1111 1111 है और OTP 482913", lang="hi")
    run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    joined = " ".join(sent_to_mt)
    assert sent_to_mt, "the Hindi input was translated"
    assert "4111" not in joined and "482913" not in joined


def test_colons_come_back_but_real_visargas_stay():
    from app.brain.language import _restore_colons

    assert _restore_colons("Colour: Midnight Black", "रंगः Midnight Black") == "रंग: Midnight Black"
    assert _restore_colons("Colour: Black", "రంగుః Black") == "రంగు: Black"
    assert _restore_colons("Add it?", "अतः इसे जोड़ें?") == "अतः इसे जोड़ें?"


def test_canned_turn_response_speaks_one_language(mock_body):
    """The MOCK fixture Track D develops against: the confirmation prompt is the summary."""
    canned = mock_body("TurnResponse")
    assert canned["confirmation"]["prompt"] == canned["output"]["summary"]
    assert canned["output"]["lang"] == "hi"


# --- Track A's sandbox: burst of 12 per MT model, then ~0.8/s ---


def test_at_most_four_translations_at_once_and_each_line_once(monkeypatch):
    from app.brain import language
    from app.services import bhashini

    monkeypatch.delattr(bhashini, "translate_many", raising=False)
    in_flight, peak, seen = 0, 0, []

    async def slow_translate(text, source, target):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        seen.append(text)
        await asyncio.sleep(0.01)
        in_flight -= 1
        return f"[{target}] {text}"

    monkeypatch.setattr(bhashini, "translate", slow_translate)
    lines = [f"Line {i}" for i in range(15)] + ["Yes", "No", "Yes", "No"]
    out = run(language.translate_many(lines, "en", "hi"))
    assert peak <= language.MAX_CONCURRENT
    assert len(seen) == 17, "repeated lines are translated once"
    assert out[-2:] == ["[hi] Yes", "[hi] No"]


def test_uses_track_as_translate_many_when_present(monkeypatch):
    from app.brain import language
    from app.services import bhashini

    calls = []

    async def packed(lines, source, target):
        calls.append(len(lines))
        return [f"[{target}] {line}" for line in lines]

    async def single(*_a, **_k):
        raise AssertionError("single-line translate must not be used")

    monkeypatch.setattr(bhashini, "translate_many", packed, raising=False)
    monkeypatch.setattr(bhashini, "translate", single)
    out = run(language.translate_many(["Colour: Black", "Add Zentra Pulse 5G?"], "en", "hi"))
    assert calls == [2]
    assert out[1].startswith("[hi] ") and "Zentra Pulse 5G" in out[1]


def test_packed_translation_that_loses_a_name_keeps_english(monkeypatch):
    from app.brain import language
    from app.services import bhashini

    async def drops_names(lines, source, target):
        return ["कार्ट में जोड़ें?" for _ in lines]

    monkeypatch.setattr(bhashini, "translate_many", drops_names, raising=False)
    assert run(language.translate_many(["Add Zentra Pulse 5G to your cart?"], "en", "hi")) is None


# --- verbosity / lite mode: at most 3 options, summaries never cut ---


@pytest.mark.parametrize(
    ("verbosity", "lite", "chips"),
    [("normal", False, 4), ("short", False, 3), ("normal", True, 3)],
)
def test_short_and_lite_users_get_at_most_three_options(mock_body, verbosity, lite, chips):
    session.reset()
    data = mock_body("TurnRequest")
    data["prefs"].update(verbosity=verbosity, lite_mode=lite)
    data["input"].update(
        kind="voice", text="", asr_meta={"confidence": None, "mic_level": 0.6, "alternatives": []}
    )
    r = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert len(r.output.followups) == chips
    assert r.output.summary == "I didn't catch that. You can choose one of these."


def test_short_users_keep_the_whole_confirmation(mock_body):
    data = mock_body("TurnRequest")
    data["prefs"].update(verbosity="short", lang="en")
    data["input"].update(kind="switch", target_id="t-add-to-cart", lang="en")
    r = run(orchestrator.handle_turn(TurnRequest.model_validate(data)))
    assert r.output.summary == "Add Zentra Pulse 5G to your cart? Quantity 1, price ₹17,999."
    assert r.confirmation.read_back.total.amount == 17999


def test_short_prepare_keeps_the_cache_full(mock_body, monkeypatch):
    from app.brain import prepare
    from app.models import ProductPrepareRequest

    monkeypatch.setattr(prepare, "_cache", prepare.TTLCache(60))
    short = mock_body("ProductPrepareRequest")
    normal = json.loads(json.dumps(short))
    normal["prefs"]["verbosity"] = "normal"
    a = run(prepare.prepare(ProductPrepareRequest.model_validate(short)))
    b = run(prepare.prepare(ProductPrepareRequest.model_validate(normal)))
    assert all(len(s.items) <= 3 for s in a.sections.specs.sections)
    assert any(len(s.items) > 3 for s in b.sections.specs.sections)


def test_turn_uses_one_packed_translation_per_answer(req, monkeypatch):
    """With Track A's translate_many, a whole answer costs one packed call (not one per line)."""
    from app.services import bhashini

    calls = []

    async def fake_many(lines, source, target):
        calls.append(len(lines))
        return [f"[{target}] {line}" for line in lines]

    async def single(*_a, **_k):
        raise AssertionError("answers must not be translated line by line")

    monkeypatch.setattr(bhashini, "translate_many", fake_many, raising=False)
    monkeypatch.setattr(bhashini, "translate", single)
    long_answer = run(tools.read_section(tools.Context(req), "reviews")).output
    out = run(orchestrator._translate_output(long_answer, "hi"))
    assert len(calls) == 1 and calls[0] >= 10
    assert out.lang.value == "hi"
    assert out.summary.startswith("[hi] ")
