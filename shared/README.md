# shared/ — contracts

**Frozen at 1.0.** Decisions are recorded in `docs/decisions.md` ("Schema freeze v1.0").
Every top-level object carries `schema_version: "1.0"`.

## Change rules

- **Additive optional field** (or a new enum value that old readers can ignore): a small
  `schema/<change>` PR, announced to the team before merging; minor version bump (1.0 → 1.1).
- **Breaking change** (removing or renaming a field, changing a type, making something required,
  removing an enum value): all affected tracks agree first; major version bump (1.x → 2.0).
- Every schema change updates its fixtures in `fixtures/mocks/` and the regenerated types in the
  same PR. `make check` must pass.

## Layout

- `schemas/` — JSON Schema (draft 2020-12), the single source of truth.
  - `common.schema.json` — shared definitions only: `SchemaVersion`, `Lang`, `Money`, `AsrMeta`.
  - Contracts: ProductJSON, PageContext, ActionTarget, OrderJSON, Profile (with `Prefs`),
    ResolvedMode, TurnRequest, TurnResponse, ClientAction, Confirmation, AccessibleOutput.
  - `api/` — request/response bodies for the other backend endpoints and `ErrorResponse`.
- `generated/` — produced by `make types`. **Never hand-edit.** Committed so builds don't need
  codegen; `make check` fails if it is stale.
  - `generated/ts/index.ts` (json-schema-to-typescript), imported as `@shared/index` in the extension.
  - `generated/py/contracts/` (datamodel-code-generator, Pydantic v2), re-exported by
    `backend/app/models.py`.

## Conventions

snake_case keys; ISO 8601 dates (`format: date-time`, order and delivery dates `format: date`);
closed enums; `additionalProperties: false` everywhere. Data fields are required-but-nullable
and unknowns are listed in `missing` as dot paths; optional fields exist only for request options
(`TTSRequest.voice`, `ASRRequest.sample_rate`/`mic_level`, `VisionDescribeRequest.product_id`).

Schemas have no `$id`; cross-file `$ref`s are relative paths. Each schema's `title` is its type
name, and fixtures in `fixtures/mocks/` are named `<Title>.json` or `<Title>.<variant>.json`.

## Known generator limits

- `OCRRequest`'s "exactly one of image_url / image_base64" (`oneOf`) is enforced by JSON Schema
  (fixture validation, route tests). The generated Pydantic model is a union of the two shapes,
  so it accepts a body with both; the TS type is loose (`image_url?`, `image_base64?`).
