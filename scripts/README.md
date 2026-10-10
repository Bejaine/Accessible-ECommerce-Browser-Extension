# scripts/

- `gen_ts.mjs` — schemas → `shared/generated/ts/index.ts` (run via `make types`).
- `gen_py.sh` — schemas → `shared/generated/py/contracts/` (run via `make types`).
- `validate_fixtures.py` — validates `fixtures/mocks/` against the schemas (run via `make check`).
