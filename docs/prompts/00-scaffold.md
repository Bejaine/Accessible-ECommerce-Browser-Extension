# Scaffold prompt (integration lead runs once, on branch chore/scaffold)

Paste everything below the line into Claude Code at the repo root.

---
Scaffold this repository exactly as described in CLAUDE.md and the docs it imports. Plan first:
list every file you will create and wait for my approval before writing anything. Do not
implement features; every module is a stub that compiles, has one passing test, and works in
MOCK mode.

Create:
1. The directory tree from CLAUDE.md's "Repo layout", with a short README.md in each top-level folder.
2. Root `package.json` (private) with Prettier and ESLint as dev dependencies and shared configs
   (`.prettierrc`, `eslint.config.js`), so `.claude/hooks/format.sh` works from the root.
3. `extension/`: a WXT + TypeScript (strict) project that builds for Chrome and Firefox (MV3),
   with an injected shadow-DOM overlay containing one ARIA live region (`src/ui/announce.ts`),
   a stub message bus in `src/core/`, empty modules for every folder in the layout, and
   `VITE_BACKEND=mock` support. Create files directly rather than running interactive generators.
4. `backend/`: FastAPI app (Python 3.11, `pyproject.toml` with fastapi, uvicorn, pydantic v2,
   httpx, pytest, ruff), `/health`, stub routes for every endpoint in CLAUDE.md returning
   fixtures when `MOCK=1`, `app/services/bhashini.py` with the model-registry loader and a
   token-bucket limiter reading `backend/config/models.example.json` shape.
5. `shared/schemas/`: JSON Schema (draft 2020-12) drafts for ProductJSON, PageContext, ActionTarget,
   Profile, ResolvedMode, TurnRequest, TurnResponse, ClientAction, Confirmation, AccessibleOutput,
   OrderJSON, following the contract summaries in CLAUDE.md. Mark them DRAFT in a README; the team
   will review them before freezing.
6. Type generation: `make types` produces `shared/generated/ts/` (json-schema-to-typescript) and
   `shared/generated/py/` (datamodel-code-generator), and both apps import from there.
7. One valid example fixture per schema in `fixtures/mocks/`, and `scripts/validate_fixtures.py`
   that validates every fixture against its schema.
8. `Makefile` with: setup, types, check (lint + tests + fixture validation for both apps),
   backend, ext, ext-firefox.
9. `.github/workflows/check.yml` running `make setup && make check` on every pull request.
10. Root README: setup steps (Node, Python, jq, ruff, web-ext), how to run each part, the
    "declared libraries, APIs and datasets" section listing everything you added.

When done: run `make check` until it passes, then summarise what exists and what is stubbed.
