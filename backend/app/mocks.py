"""MOCK=1: serve fixtures/mocks/<SchemaTitle>.json, validated by the generated model."""

from __future__ import annotations

from typing import TypeVar

from pydantic import BaseModel

from app.config import get_settings

M = TypeVar("M", bound=BaseModel)


def fixture(model: type[M], name: str | None = None) -> M:
    path = get_settings().fixtures_dir / "mocks" / f"{name or model.__name__}.json"
    return model.model_validate_json(path.read_text())
