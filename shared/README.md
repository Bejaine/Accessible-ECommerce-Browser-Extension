# shared/ — contracts

> **DRAFT — not frozen.** These schemas follow the contract summaries in CLAUDE.md and still need
> team review. Until they are frozen, expect field changes. After freezing, changes go in their
> own `schema/<change>` PR, announced to the team before merging.

- `schemas/` — JSON Schema (draft 2020-12), the single source of truth.
  - Contracts: ProductJSON, PageContext, ActionTarget, Profile (with `Prefs`, `Verbosity`),
    ResolvedMode, TurnRequest, TurnResponse, ClientAction, Confirmation, AccessibleOutput, OrderJSON.
  - `api/` — request/response bodies for the backend endpoints that have no contract in
    CLAUDE.md (ASR, TTS, translate, OCR, vision, reviews, product/prepare, health, errors).
- `generated/` — produced by `make types`. **Never hand-edit.** Committed so builds don't need
  codegen; `make check` fails if it is stale.
  - `generated/ts/index.ts` (json-schema-to-typescript), imported as `@shared/index` in the extension.
  - `generated/py/contracts/` (datamodel-code-generator, Pydantic v2), re-exported by `backend/app/models.py`.

Schemas have no `$id`; cross-file `$ref`s are relative paths (`ProductJSON.schema.json`,
`Profile.schema.json#/$defs/Prefs`). Each schema's `title` is its type name, and fixtures in
`fixtures/mocks/` are named after it.

Open questions for review:
- Which ProductJSON fields are required-but-nullable versus optional (`rating`, `variants`, `delivery`).
- `TurnResponse.confidence` / `alternatives` (from docs/conditions.md) are optional additions.
- `AccessibleOutput.summary` has a 400-character cap as a stand-in for "two short sentences".
