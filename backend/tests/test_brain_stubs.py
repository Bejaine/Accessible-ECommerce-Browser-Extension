from app.brain.intent import decision
from app.brain.recommender import rank
from app.brain.tools import TOOL_SPECS, TOOLS


def test_intent_thresholds():
    assert [decision(c) for c in (0.9, 0.8, 0.6, 0.4)] == ["act", "act", "ask", "chips"]


def test_recommender_and_tool_specs():
    assert rank([]) == []
    assert {spec["function"]["name"] for spec in TOOL_SPECS} == set(TOOLS)
