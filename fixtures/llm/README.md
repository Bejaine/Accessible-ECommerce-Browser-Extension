# Recorded LLM responses (Track C)

With `MOCK=1` the backend replays these instead of calling Groq. Each file is
`{"model": ..., "response": <raw Groq chat-completion JSON>}`, named by its recording key:

- `summary/<section>.<product id with ":" as "_">.json` — section summaries for `/product/prepare`
- `summary/test.*.json` — deliberately bad answers used by tests (invented specs, wrong sentiment, not JSON)

The first files were hand-written in Groq's format before an API key was available (they
carry a `_note`). To replace them with real recordings:

```
cd backend
LIVE_LLM=1 MOCK=0 LLM_RECORD=1 ../.venv/bin/pytest -s tests/test_llm_live.py
```

Review the new files (they must still pass `make check`) before committing. Never put
personal data in a recording; summaries only ever see public product JSON.
