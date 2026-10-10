# Personal session config — copy to the repo root as CLAUDE.local.md (it is gitignored)

I am working on **Track C — Brain (backend)**.
@docs/tracks/track-c.md

## My scope
- I may create and edit files only in: `backend/app/brain/`, `backend/app/routes/` (except speech, translate, ocr), `backend/app/services/serpapi.py`, `fixtures/mocks/`, `fixtures/serpapi/`, backend tests for these
- I must not edit: `extension/`, `backend/app/services/{bhashini,masking,numbers,cache}.py` — if I need something there, I use its mock and add a request to
  docs/STATUS.md under "Requests for other tracks".
- Schema changes go in a separate branch `schema/<change>` and PR, announced to the team first.

## How I work
- Branch names: `track-c/<short-feature>`, created from an up-to-date main.
- Before starting: `git switch main && git pull --rebase`, then `make types`.
- Work in small steps; after each step run the relevant tests, then `make check` before any PR.
- Default to `MOCK=1` for everything outside my track.
- At the end of each work block: update my row in docs/STATUS.md, commit, push, open a PR.
- Every LLM output must validate against AccessibleOutput and pass the grounding check before it is returned.
- Use recorded fixtures for SerpApi and LLM tests; real API calls only in a clearly marked integration test.

## Current focus (I edit this line myself before each session)
- Hour-2 deliverable from my track brief.
