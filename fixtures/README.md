# fixtures/

- `mocks/` — one valid example per schema, named `<SchemaTitle>.json` (or `<SchemaTitle>.<variant>.json`).
  Served by backend routes with `MOCK=1` and by the extension with `VITE_BACKEND=mock`.
  `make check` validates every file here (`scripts/validate_fixtures.py`). When you change a
  response shape, update its fixture in the same PR. All data is synthetic.
- `serpapi/` — recorded SerpApi responses, `amazon_product.<ASIN>.json` (Track C). The current file is a synthetic placeholder.
- `language-api/` — AnuvaadHub example requests/responses from the API spec (Track A).
- `pages/` — saved HTML of real product/search/cart pages (Track B).
- `audio/` — sample audio for ASR round trips and evaluation (Track A).
