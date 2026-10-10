"""Settings from the environment (.env is loaded by the shell / Makefile, never committed)."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]


def _flag(name: str, default: str) -> bool:
    return os.getenv(name, default).strip().lower() in {"1", "true", "yes", "on"}


def _path(name: str, default: Path) -> Path:
    value = os.getenv(name)
    if not value:
        return default
    p = Path(value)
    return p if p.is_absolute() else REPO_ROOT / p


@dataclass(frozen=True)
class Settings:
    mock: bool = field(default_factory=lambda: _flag("MOCK", "1"))
    fixtures_dir: Path = field(
        default_factory=lambda: _path("FIXTURES_DIR", REPO_ROOT / "fixtures")
    )
    models_file: Path = field(
        default_factory=lambda: _path(
            "LANGUAGE_MODELS_FILE", REPO_ROOT / "backend/config/models.local.json"
        )
    )
    serpapi_api_key: str = field(default_factory=lambda: os.getenv("SERPAPI_API_KEY", ""))


def get_settings() -> Settings:
    return Settings()
