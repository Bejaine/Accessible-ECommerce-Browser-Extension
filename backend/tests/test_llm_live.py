"""LIVE Groq test: real API calls. Skipped unless LIVE_LLM=1 and GROQ_API_KEY are set.

    set -a; source .env; set +a      # from the repo root, loads GROQ_API_KEY
    cd backend && LIVE_LLM=1 MOCK=0 ../.venv/bin/pytest -s tests/test_llm_live.py
Add LLM_RECORD=1 to save the real responses to fixtures/llm/ (then review and commit them).
"""

import asyncio
import os

import pytest

from app.brain.grounding import check
from app.brain.llm_sections import llm_section
from app.models import ProductJSON

pytestmark = pytest.mark.skipif(
    os.getenv("LIVE_LLM") != "1" or not os.getenv("GROQ_API_KEY"),
    reason="live Groq test: set LIVE_LLM=1 and GROQ_API_KEY",
)


@pytest.mark.parametrize("name", ["overview", "specs", "reviews"])
def test_live_summary_is_grounded(mock_body, monkeypatch, name):
    monkeypatch.setenv("MOCK", "0")
    product = ProductJSON.model_validate(mock_body("ProductJSON"))
    result = asyncio.run(llm_section(name, product))
    out = result.output
    print(f"\n== {name}\nsummary: {out.summary}\nsimpler: {out.simpler}")
    for section in out.sections:
        print(f"  # {section.heading}")
        for item in section.items:
            print(f"    - [{item.kind.value}] {item.text}")
    print(f"dropped: {result.dropped}")
    assert check(out, {product.id: product}, result.derived).dropped == []
