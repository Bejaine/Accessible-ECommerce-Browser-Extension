"""Builder for AccessibleOutput: every item that states a fact is created with its grounding."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from app.brain.grounding import CheckResult, check
from app.models import SCHEMA_VERSION, AccessibleOutput

Item = dict[str, Any]


class OutputBuilder:
    def __init__(self, subject_id: str | None = None):
        self.subject_id = subject_id
        self.grounding: list[dict[str, str]] = []
        self.sections: list[dict[str, Any]] = []
        self.derived: set[float] = set()

    def ground(self, claim: str, field_path: str, subject_id: str | None = None) -> int:
        subject = subject_id or self.subject_id
        if subject is None:
            raise ValueError("grounding needs a subject_id")
        entry = {"claim": claim, "subject_id": subject, "field_path": field_path}
        if entry in self.grounding:
            return self.grounding.index(entry)
        self.grounding.append(entry)
        return len(self.grounding) - 1

    def item(
        self,
        text: str,
        kind: str = "text",
        *,
        claim: str | None = None,
        path: str | None = None,
        subject_id: str | None = None,
    ) -> Item:
        index = self.ground(claim or text, path, subject_id) if path else None
        return {"text": text, "kind": kind, "grounding_index": index}

    def section(
        self,
        heading: str,
        items: Iterable[Item] = (),
        *,
        table: Mapping[str, Any] | None = None,
        simpler: str | None = None,
    ) -> None:
        self.sections.append(
            {
                "heading": heading,
                "items": list(items),
                "table": dict(table) if table else None,
                "simpler": simpler,
            }
        )

    def derive(self, *values: float) -> None:
        """Numbers our code computed (counts, totals), allowed in free text."""
        self.derived.update(float(v) for v in values)

    def build(
        self,
        summary: str,
        *,
        simpler: str | None = None,
        followups: Iterable[str] = (),
        warnings: Iterable[str] = (),
        lang: str = "en",
    ) -> AccessibleOutput:
        return AccessibleOutput.model_validate(
            {
                "schema_version": SCHEMA_VERSION,
                "lang": lang,
                "summary": summary,
                "sections": self.sections,
                "simpler": simpler,
                "followups": list(followups),
                "grounding": self.grounding,
                "warnings": list(warnings),
            }
        )

    def checked(self, subjects: Mapping[str, Any], summary: str, **kwargs: Any) -> CheckResult:
        return check(self.build(summary, **kwargs), subjects, self.derived)


def plain_output(
    summary: str, *, followups: Iterable[str] = (), lang: str = "en"
) -> AccessibleOutput:
    """A message with no product claims (prompts, errors, "did you mean")."""
    return OutputBuilder().build(summary, followups=followups, lang=lang)
