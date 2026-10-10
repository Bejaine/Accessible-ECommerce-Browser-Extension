# backend/ — FastAPI

```
make backend          # http://localhost:8000, MOCK=1 by default
MOCK=0 make backend   # real services (only what is implemented; others return 501)
make test-backend
```

- `app/main.py` wires the routes; `app/routes/` are thin and validate input/output with the
  generated Pydantic models (`app/models.py` re-exports `shared/generated/py/contracts`).
- `app/mocks.py` serves `fixtures/mocks/<Schema>.json` when `MOCK=1`.
- `app/services/bhashini.py` is the only module that may call Bhashini/AnuvaadHub (rule 6). It
  loads `config/models.local.json` (gitignored; copy `models.example.json`) and rate-limits per model.
- `app/services/serpapi.py` is the only module that may call SerpApi (rule 9).
- Errors are always `{error, code, retryable}`.

Ownership: `services/{bhashini,masking,numbers,cache}.py` Track A; `brain/`, `routes/`,
`services/serpapi.py` Track C.
