# scripts/

- `gen_ts.mjs` — schemas → `shared/generated/ts/index.ts` (run via `make types`).
- `gen_py.sh` — schemas → `shared/generated/py/contracts/` (run via `make types`).
- `validate_fixtures.py` — validates `fixtures/mocks/` against the schemas (run via `make check`).
- `build_phrases.py` (Track A) — translates `extension/src/i18n/en.json` into `hi.json`/`te.json`
  (only missing keys) and records each UI string as 16 kHz audio in `extension/src/i18n/audio/`.
  Real API calls: run by hand with `MOCK=0` and tokens; review new translations before committing.
