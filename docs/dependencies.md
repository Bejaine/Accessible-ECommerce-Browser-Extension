# Declared libraries, APIs and datasets

Add to this list in the same PR that introduces a dependency (docs/product.md). Moved here from
the README, which holds setup and run instructions only.

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
