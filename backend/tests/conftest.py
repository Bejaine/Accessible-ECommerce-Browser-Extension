import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

os.environ.setdefault("MOCK", "1")

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))

from validate_fixtures import load_schemas  # noqa: E402

from app.main import app  # noqa: E402

_SCHEMAS, _REGISTRY = load_schemas()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def assert_schema():
    """Assert a JSON body is valid against the schema with this title."""

    def check(title: str, body: object) -> None:
        validator = Draft202012Validator(_SCHEMAS[title], registry=_REGISTRY)
        errors = [e.message for e in validator.iter_errors(body)]
        assert not errors, f"{title}: {errors}"

    return check


@pytest.fixture
def mock_body():
    import json

    def load(title: str) -> dict:
        return json.loads((REPO / "fixtures" / "mocks" / f"{title}.json").read_text())

    return load


@pytest.fixture(autouse=True)
def _fresh_llm_key_cooldowns():
    """Groq key cooldowns live for the process; never let one test's 429 leak into another."""
    from app.brain import llm

    llm.reset_key_cooldowns()
    yield
    llm.reset_key_cooldowns()
