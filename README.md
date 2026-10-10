# Accessible Shopping Layer

A browser extension (Chrome desktop + Firefox for Android) and a FastAPI backend that make real
e-commerce sites usable for people with visual, speech, hand-motor and age-related impairments,
in English and Indian languages via Bhashini. Megathon 2026, Bhashini track.

Read `CLAUDE.md` first: it holds the product rules, contracts and track ownership.

## Setup

Prerequisites:

| Tool | Version | Why |
|---|---|---|
| Node.js | 20+ (CI uses 22) | extension, Prettier/ESLint, type generation |
| Python | 3.11 (exactly) | backend |
| [uv](https://docs.astral.sh/uv/) | any (optional) | faster Python installs; `make setup` falls back to pip |
| jq | any | `.claude/hooks/format.sh` |
| ruff | on PATH | `.claude/hooks/format.sh` formats Python after every edit; `uv tool install ruff`, or activate `.venv` |
| Chrome and/or Firefox | system install | `make ext` / `make ext-firefox` open them with the extension loaded (web-ext is installed by `make setup`) |

```
make setup     # npm install (root + extension workspace) and .venv with backend[dev]
make types     # regenerate shared/generated/ from shared/schemas/
make check     # generated types fresh, Prettier, ESLint, tsc, Vitest, ruff, pytest, fixture validation
```

If `python3.11` isn't your interpreter's name: `make setup PY=/path/to/python3.11`.
Copy `.env.example` to `.env` and `backend/config/models.example.json` to
`backend/config/models.local.json` when you have real keys (both are gitignored).

## Running

- Backend: `make backend` (MOCK=1 by default; every route serves `fixtures/mocks/`). Docs at http://localhost:8000/docs.
- Extension, Chrome: `make ext`. Firefox: `make ext-firefox`. Both default to `VITE_BACKEND=mock`.
- Firefox for Android: see `extension/README.md`.
- Tests only: `make test` (or `make test-ext`, `make test-backend`).

## Layout

See CLAUDE.md "Repo layout". Each top-level folder has a README with its owner.
Contracts are in `shared/schemas/` (DRAFT until the team freezes them; see `shared/README.md`).

## Declared libraries, APIs and datasets

Add to this list in the same PR that introduces a dependency (docs/product.md).

**JavaScript / TypeScript**
- [WXT](https://wxt.dev) — WebExtension framework (MV3 builds for Chrome and Firefox)
- [TypeScript](https://www.typescriptlang.org) — pinned to 6.0.x for typescript-eslint compatibility
- [Vitest](https://vitest.dev) + [happy-dom](https://github.com/capricorn86/happy-dom) — extension unit tests
- [ESLint](https://eslint.org), [@eslint/js](https://www.npmjs.com/package/@eslint/js), [typescript-eslint](https://typescript-eslint.io), [globals](https://www.npmjs.com/package/globals) — linting
- [Prettier](https://prettier.io) — formatting
- [axe-core](https://github.com/dequelabs/axe-core) — automated accessibility checks of the overlay in tests
- [web-ext](https://github.com/mozilla/web-ext) — launches Chrome/Firefox for `make ext`, and Firefox for Android
- [json-schema-to-typescript](https://github.com/bcherny/json-schema-to-typescript) — TS types from schemas
- [Ajv](https://ajv.js.org) + [ajv-formats](https://github.com/ajv-validator/ajv-formats) — validates extractor output against the JSON Schemas in extension tests (dev only)

**Python**
- [FastAPI](https://fastapi.tiangolo.com), [Uvicorn](https://www.uvicorn.org), [Pydantic v2](https://docs.pydantic.dev) — backend
- [HTTPX](https://www.python-httpx.org) — HTTP client (and FastAPI test client)
- [jsonschema](https://python-jsonschema.readthedocs.io) — fixture and schema validation
- [pytest](https://pytest.org), [pytest-asyncio](https://pytest-asyncio.readthedocs.io) — tests
- [Ruff](https://docs.astral.sh/ruff/) — lint and format

**Data**
- `fixtures/pages/` — saved public Amazon.in and Flipkart product/search pages (captured logged-out on 2026-10-10, scripts and reviewer identities removed), used only for offline extractor tests
- [datamodel-code-generator](https://github.com/koxudaxi/datamodel-code-generator) — Pydantic models from schemas

**APIs**
- Bhashini models via AnuvaadHub (ASR, MT, TTS, OCR) — only through `backend/app/services/bhashini.py` (stub)
- SerpApi `amazon_product` — only through `backend/app/services/serpapi.py`; development uses `fixtures/serpapi/`
- [Groq](https://console.groq.com) chat completions (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`, strict
  structured outputs) — section summaries and `/turn` tool calls, only through `backend/app/brain/llm.py`;
  tests replay `fixtures/llm/`
- [Gemini API](https://ai.google.dev) (Interactions endpoint, `gemini-3.5-flash-lite`, `store: false`) —
  product photo descriptions, only through `backend/app/brain/vision.py`; tests replay `fixtures/llm/vision/`

**Datasets**
- None added yet. Planned: TORGO (dysarthric speech) for `eval/`.

**CI**
- GitHub Actions: actions/checkout, actions/setup-node, actions/setup-python, astral-sh/setup-uv
