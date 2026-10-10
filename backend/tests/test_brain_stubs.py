from app.brain.intent import decision
from app.brain.recommender import rank
from app.brain.tools import TOOLS


def test_intent_thresholds():
    assert [decision(c) for c in (0.9, 0.8, 0.6, 0.4)] == ["act", "act", "ask", "chips"]


def test_stub_recommender_and_tools():
    assert rank([], {}) == []
    assert TOOLS == {}
