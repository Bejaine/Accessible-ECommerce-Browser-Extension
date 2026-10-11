"""Several Groq keys, switched lazily: stay on a key until it is rate limited, then use the next
one; each (key, model) cools down for as long as Groq says. Keys never appear in logs or errors."""

import asyncio
import json
import logging

import httpx
import pytest

from app.brain import llm
from app.brain.llm import LLMError, RateLimited

BODY = {"messages": [{"role": "user", "content": "hi"}]}
OK = {"choices": [{"message": {"content": "{}"}}]}
BIG, SMALL = "openai/gpt-oss-120b", "openai/gpt-oss-20b"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def real_mode(monkeypatch):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setenv("GROQ_API_KEY", "gsk_first_aaaa")
    monkeypatch.setenv("GROQ_API_KEYS", "gsk_second_bbbb, gsk_third_cccc")
    now = [1000.0]
    monkeypatch.setattr(llm, "_clock", lambda: now[0])
    llm.reset_key_cooldowns()
    yield now
    llm.reset_key_cooldowns()


def fake_groq(monkeypatch, decide):
    """`decide(key, model)` returns None (ok) or an exception for _post to raise."""
    calls = []

    async def fake_post(body, cfg):
        calls.append((cfg.api_key, body["model"]))
        outcome = decide(cfg.api_key, body["model"])
        if outcome is not None:
            raise outcome
        return OK

    monkeypatch.setattr(llm, "_post", fake_post)
    return calls


def test_keys_come_from_both_settings_in_order_without_duplicates(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEYS", "gsk_second_bbbb,\n gsk_first_aaaa  gsk_third_cccc,,")
    assert llm.LLMSettings.load().api_keys == (
        "gsk_first_aaaa",
        "gsk_second_bbbb",
        "gsk_third_cccc",
    )


def test_only_the_list_is_enough(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY")
    assert llm.LLMSettings.load().api_keys == ("gsk_second_bbbb", "gsk_third_cccc")


def test_no_key_at_all_still_names_the_setting(monkeypatch):
    monkeypatch.delenv("GROQ_API_KEY")
    monkeypatch.delenv("GROQ_API_KEYS")
    with pytest.raises(LLMError, match="GROQ_API_KEY"):
        run(llm.chat("k", [BIG], BODY))


def test_stays_on_the_first_key_while_it_works(monkeypatch):
    calls = fake_groq(monkeypatch, lambda key, model: None)
    run(llm.chat("k", [BIG], BODY))
    run(llm.chat("k", [BIG], BODY))
    assert calls == [("gsk_first_aaaa", BIG), ("gsk_first_aaaa", BIG)]


def test_switches_key_when_one_is_rate_limited_and_keeps_the_best_model(monkeypatch):
    limited = RateLimited("tokens per day", retry_after=1120.0)
    calls = fake_groq(monkeypatch, lambda key, model: limited if key == "gsk_first_aaaa" else None)
    run(llm.chat("k", [BIG, SMALL], BODY))
    assert calls == [("gsk_first_aaaa", BIG), ("gsk_second_bbbb", BIG)]


def test_a_cooling_key_is_skipped_without_calling_groq(monkeypatch, real_mode):
    limited = RateLimited("tokens per day", retry_after=1120.0)
    calls = fake_groq(monkeypatch, lambda key, model: limited if key == "gsk_first_aaaa" else None)
    run(llm.chat("k", [BIG], BODY))
    calls.clear()
    run(llm.chat("k", [BIG], BODY))
    assert calls == [("gsk_second_bbbb", BIG)]


def test_the_first_key_is_used_again_once_its_cooldown_ends(monkeypatch, real_mode):
    first_limited = [True]

    def decide(key, model):
        if key == "gsk_first_aaaa" and first_limited[0]:
            return RateLimited("tokens per minute", retry_after=30.0)
        return None

    calls = fake_groq(monkeypatch, decide)
    run(llm.chat("k", [BIG], BODY))
    first_limited[0] = False
    real_mode[0] += 31
    calls.clear()
    run(llm.chat("k", [BIG], BODY))
    assert calls == [("gsk_first_aaaa", BIG)]


def test_cooldown_is_per_model(monkeypatch):
    def decide(key, model):
        return RateLimited("120b daily", retry_after=600.0) if model == BIG else None

    calls = fake_groq(monkeypatch, decide)
    run(llm.chat("k", [BIG, SMALL], BODY))  # every key is out of 120b: falls to 20b on key 1
    assert calls[-1] == ("gsk_first_aaaa", SMALL)
    calls.clear()
    run(llm.chat("k", [SMALL], BODY))
    assert calls == [("gsk_first_aaaa", SMALL)]


def test_a_rejected_key_is_parked_and_the_next_one_used(monkeypatch, real_mode):
    rejected = llm.KeyRejected("groq 401")
    calls = fake_groq(monkeypatch, lambda key, model: rejected if key == "gsk_first_aaaa" else None)
    run(llm.chat("k", [BIG], BODY))
    real_mode[0] += 3600  # an hour later it is still skipped, for every model
    calls.clear()
    run(llm.chat("k", [SMALL], BODY))
    assert calls == [("gsk_second_bbbb", SMALL)]


def test_when_every_key_is_cooling_it_fails_fast_without_calls(monkeypatch):
    limited = RateLimited("tokens per day", retry_after=600.0)
    calls = fake_groq(monkeypatch, lambda key, model: limited)
    with pytest.raises(RateLimited):
        run(llm.chat("k", [BIG, SMALL], BODY))
    assert len(calls) == 6  # 3 keys x 2 models, each tried once
    calls.clear()
    with pytest.raises(RateLimited, match="all Groq keys"):
        run(llm.chat("k", [BIG, SMALL], BODY))
    assert calls == []


def test_keys_never_appear_in_logs_or_errors(monkeypatch, caplog):
    limited = RateLimited("tokens per day", retry_after=600.0)
    fake_groq(monkeypatch, lambda key, model: limited)
    with caplog.at_level(logging.WARNING), pytest.raises(LLMError) as exc:
        run(llm.chat("k", [BIG], BODY))
    text = caplog.text + str(exc.value)
    for key in ("gsk_first_aaaa", "gsk_second_bbbb", "gsk_third_cccc"):
        assert key not in text
    assert "#1 (…aaaa)" in caplog.text  # keys are named by position and last 4 characters


# --- _post: reading Groq's 429 reply ------------------------------------------------------


def groq_reply(monkeypatch, status, body=None, headers=None):
    transport = httpx.MockTransport(
        lambda req: httpx.Response(status, json=body or {}, headers=headers or {})
    )
    monkeypatch.setattr(llm, "_transport", transport)


def cfg():
    return llm.LLMSettings.load()


@pytest.mark.parametrize(
    ("message", "seconds"),
    [
        ("... tokens per day (TPD) ... Please try again in 18m40.176s.", 1120.176),
        ("Rate limit reached ... tokens per minute (TPM) ... Please try again in 2.5s.", 2.5),
        ("... requests per day (RPD) ... Please try again in 1h2m3s.", 3723.0),
        ("... Please try again in 450ms.", 0.45),
    ],
)
def test_429_cooldown_comes_from_groqs_message(monkeypatch, message, seconds):
    groq_reply(monkeypatch, 429, {"error": {"message": message}})
    with pytest.raises(RateLimited) as exc:
        run(llm._post({**BODY, "model": BIG}, cfg()))
    assert exc.value.retry_after == pytest.approx(seconds, abs=0.01)


def test_429_uses_retry_after_header_when_the_message_has_no_time(monkeypatch):
    groq_reply(monkeypatch, 429, {"error": {"message": "slow down"}}, {"retry-after": "7"})
    with pytest.raises(RateLimited) as exc:
        run(llm._post({**BODY, "model": BIG}, cfg()))
    assert exc.value.retry_after == 7


def test_429_without_any_time_waits_a_minute(monkeypatch):
    groq_reply(monkeypatch, 429, {"error": {"message": "slow down"}})
    with pytest.raises(RateLimited) as exc:
        run(llm._post({**BODY, "model": BIG}, cfg()))
    assert exc.value.retry_after == 60


@pytest.mark.parametrize("status", [401, 403])
def test_401_403_mean_the_key_is_rejected(monkeypatch, status):
    groq_reply(monkeypatch, status, {"error": {"message": "Invalid API Key"}})
    with pytest.raises(llm.KeyRejected):
        run(llm._post({**BODY, "model": BIG}, cfg()))


def test_other_errors_are_not_blamed_on_the_key(monkeypatch):
    groq_reply(monkeypatch, 400, {"error": {"message": "bad request"}})
    with pytest.raises(LLMError) as exc:
        run(llm._post({**BODY, "model": BIG}, cfg()))
    assert not isinstance(exc.value, (RateLimited, llm.KeyRejected))


def test_429_message_is_kept_for_the_log(monkeypatch):
    msg = "Rate limit reached for model `openai/gpt-oss-120b` on tokens per day (TPD)"
    groq_reply(monkeypatch, 429, {"error": {"message": msg}})
    with pytest.raises(RateLimited) as exc:
        run(llm._post({**BODY, "model": BIG}, cfg()))
    assert "tokens per day" in str(exc.value)
    json.dumps(str(exc.value))  # plain text
