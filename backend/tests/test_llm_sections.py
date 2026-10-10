"""LLM-written sections, replayed from fixtures/llm/summary/ (MOCK=1, no network)."""

import asyncio
import json

import pytest

from app.brain import llm
from app.brain import prepare as prepare_mod
from app.brain.grounding import check
from app.brain.llm import LLMError
from app.brain.llm_sections import OUTPUT_SCHEMA, assemble, llm_section, section_input

PID = "amazon.in:B0ZNTRA5G1"


@pytest.fixture
def product(mock_body):
    from app.models import ProductJSON

    return ProductJSON.model_validate(mock_body("ProductJSON"))


def run(coro):
    return asyncio.run(coro)


@pytest.mark.parametrize("name", ["overview", "specs", "reviews"])
def test_recorded_answers_pass_every_check(product, name):
    result = run(llm_section(name, product))
    assert result.dropped == []
    again = check(result.output, {PID: product}, result.derived)
    assert again.dropped == []
    assert result.output.grounding


def test_reviews_keep_mention_counts(product):
    out = run(llm_section("reviews", product)).output
    assert out.summary.startswith("Based on 690 reviews")
    pros = next(s for s in out.sections if s.heading == "Pros")
    assert pros.items[0].text == "Battery life: 189 of 212 mentions are positive"
    assert {i.kind.value for i in pros.items} == {"pro"}


def test_invented_specs_are_rejected(product):
    with pytest.raises(LLMError):
        run(llm_section("specs", product, key="summary/test.specs_invented"))


def test_wrong_sentiment_and_opinions_are_dropped(product):
    result = run(llm_section("reviews", product, key="summary/test.reviews_wrong_sentiment"))
    pros = [i.text for s in result.output.sections if s.heading == "Pros" for i in s.items]
    assert "Low-light camera: 68 of 96 mentions" not in pros
    assert "Feels premium in the hand" not in pros
    assert len(result.dropped) == 2


def test_non_json_answer_is_rejected(product):
    with pytest.raises(LLMError):
        run(llm_section("specs", product, key="summary/test.not_json"))


def test_stale_answer_missing_the_price_falls_back(product):
    """The recording says ₹17,999; if the page now says ₹16,999 the price fact fails, the
    overview would lose its price, so the whole answer is rejected."""
    cheaper = product.model_copy(deep=True)
    cheaper.price.amount = 16999
    with pytest.raises(LLMError, match="price.amount"):
        run(llm_section("overview", cheaper))


def test_prepare_uses_template_when_llm_fails(product, monkeypatch):
    async def down(*_a, **_k):
        raise LLMError("groq down")

    monkeypatch.setattr("app.brain.llm_sections.complete_json", down)
    monkeypatch.setattr(prepare_mod, "_cache", prepare_mod.TTLCache(60))
    sections = run(prepare_mod.prepare_sections(product))
    assert sections["overview"].summary.startswith("Zentra Pulse 5G costs ₹17,999, down from")
    assert sections["specs"].summary.startswith("The page lists 6 specs.")


def test_prepare_uses_llm_when_recorded(product, monkeypatch):
    monkeypatch.setattr(prepare_mod, "_cache", prepare_mod.TTLCache(60))
    sections = run(prepare_mod.prepare_sections(product))
    assert "5000 mAh battery" in sections["specs"].summary
    assert not sections["specs"].summary.startswith("The page lists"), "template was used"
    assert sections["images"] is not None


def test_section_input_is_trimmed_but_keeps_paths(product):
    data = product.model_dump(mode="json", by_alias=True)
    data["reviews"]["items"] = data["reviews"]["items"] * 10
    trimmed = section_input("reviews", data)
    assert set(trimmed) == {"id", "title", "rating", "reviews", "missing"}
    assert len(trimmed["reviews"]["items"]) == 20
    assert "price" not in section_input("specs", data)


def test_request_body_is_strict_json_schema(product, monkeypatch):
    sent = {}

    async def capture(key, models, body):
        sent.update(key=key, models=models, body=body)
        path = llm.fixture_path(key)
        return json.loads(path.read_text())["response"]

    monkeypatch.setattr(llm, "chat", capture)
    monkeypatch.delenv("GROQ_MODEL", raising=False)
    monkeypatch.delenv("GROQ_FAST_MODEL", raising=False)
    run(llm_section("reviews", product))
    fmt = sent["body"]["response_format"]
    assert fmt["type"] == "json_schema"
    assert fmt["json_schema"]["strict"] is True
    assert fmt["json_schema"]["schema"] == OUTPUT_SCHEMA
    assert sent["body"]["temperature"] == 0
    assert sent["models"] == ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
    user = sent["body"]["messages"][1]["content"]
    assert '"price"' not in user, "reviews must not see fields it doesn't need"


def test_real_mode_without_key_raises(monkeypatch, product):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.delenv("GROQ_API_KEY", raising=False)
    with pytest.raises(LLMError, match="GROQ_API_KEY"):
        run(llm_section("specs", product))


def test_rate_limit_tries_next_model(monkeypatch, product):
    monkeypatch.setenv("MOCK", "0")
    monkeypatch.setenv("GROQ_API_KEY", "test")
    tried = []
    recorded = json.loads(llm.fixture_path(f"summary/specs.{PID.replace(':', '_')}").read_text())

    async def fake_post(body, _cfg):
        tried.append(body["model"])
        if len(tried) == 1:
            raise llm.RateLimited("429")
        return recorded["response"]

    monkeypatch.setattr(llm, "_post", fake_post)
    result = run(llm_section("specs", product))
    assert tried == ["openai/gpt-oss-20b", "openai/gpt-oss-120b"]
    assert result.dropped == []


def _raw(facts, summary, items=(), simpler=None):
    return {
        "facts": [{"claim": c, "field_path": p} for c, p in facts],
        "summary": [{"text": t, "fact_refs": r} for t, r in summary],
        "simpler": simpler,
        "sections": [{"heading": "At a glance", "items": list(items)}] if items else [],
    }


def _assemble(name, raw, product):
    return assemble(name, raw, product, product.model_dump(mode="json", by_alias=True))


def test_ratings_called_reviews_are_dropped(product):
    """Seen live: "4.2 from 3418 reviews" when 3,418 is the ratings count (690 reviews)."""
    raw = _raw(
        [("₹17,999", "price.amount"), ("4.2", "rating.value"), ("3418", "rating.count")],
        [("It costs ₹17,999.", [0]), ("It is rated 4.2 from 3418 reviews.", [1, 2])],
        simpler={"text": "Rated 4.2 from 3,418 ratings.", "fact_refs": [1, 2]},
    )
    result = _assemble("overview", raw, product)
    assert result.output.summary == "It costs ₹17,999."
    assert result.output.simpler == "Rated 4.2 from 3,418 ratings."


def test_unit_only_facts_and_whole_spec_citations_match(product):
    """Seen live: the model cited units as their own facts ("GB" -> specs.ram.unit)."""
    raw = _raw(
        [("8", "specs.ram.value"), ("GB", "specs.ram.unit"), ("5000 mAh", "specs.battery")],
        [("It has 8 GB RAM and a 5000 mAh battery.", [0, 1, 2])],
    )
    result = _assemble("specs", raw, product)
    assert result.dropped == []
    assert result.output.summary == "It has 8 GB RAM and a 5000 mAh battery."


def test_digits_in_the_product_name_are_not_claims(product):
    """Seen live: "Zentra Pulse 5G costs ₹17,999" was dropped because of the 5 in 5G."""
    raw = _raw(
        [
            ("₹17,999", "price.amount"),
            ("4.2", "rating.value"),
            ("3,418 ratings", "rating.count"),
            ("In stock", "availability.text"),
        ],
        [("Zentra Pulse 5G costs ₹17,999.", [0]), ("It has 6 GB RAM.", [0])],
    )
    result = _assemble("overview", raw, product)
    assert result.output.summary == "Zentra Pulse 5G costs ₹17,999."
