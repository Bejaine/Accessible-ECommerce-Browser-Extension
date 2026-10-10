# Decisions (3–5 lines each: date, decision, why, who it affects)

## 2026-10-10 — Scaffold (integration lead, affects everyone)
- Endpoint bodies without a CLAUDE.md contract get DRAFT schemas in `shared/schemas/api/`
  so every route can validate input and output with generated Pydantic models.
- `shared/generated/` is committed; `make check` regenerates and fails if it changed.
- TS types are one file (`shared/generated/ts/index.ts`, imported as `@shared/index`); Python
  types are one module per schema in the `contracts` package (on PYTHONPATH via pytest/Makefile).
- Mock fixtures are named `<SchemaTitle>.json`; the validator and mock loaders rely on that.

## Schema freeze v1.0 (template — fill in during the meeting)
Date:
Decisions: copy the final numbered list from docs/prompts/01-schema-freeze.md, noting any changes.
Affects: all tracks.
