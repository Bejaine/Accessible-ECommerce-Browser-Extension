# Personal session config — copy to the repo root as CLAUDE.local.md (it is gitignored)

I am working on **Track A — Speech and language**.
@docs/tracks/track-a.md

## My scope
- I may create and edit files only in: `backend/app/services/{bhashini,masking,numbers,cache}.py`, `backend/config/`, `extension/src/audio/`, `extension/src/i18n/`, `fixtures/language-api/`, `fixtures/audio/`, backend tests for these
- I must not edit: `extension/src/{extract,actuate,ui,render,infer,match,core}/`, `backend/app/brain/`, `backend/app/routes/` (except the speech, translate and ocr routes, which I own) — if I need something there, I use its mock and add a request to
  docs/STATUS.md under "Requests for other tracks".
- Schema changes go in a separate branch `schema/<change>` and PR, announced to the team first.

## How I work
- Branch names: `track-a/<short-feature>`, created from an up-to-date main.
- Before starting: `git switch main && git pull --rebase`, then `make types`.
- Work in small steps; after each step run the relevant tests, then `make check` before any PR.
- Default to `MOCK=1` for everything outside my track.
- At the end of each work block: update my row in docs/STATUS.md, commit, push, open a PR.
- Real language-API tokens exist only in `backend/config/models.local.json`; never print, log or commit them.
- Until tokens are approved, build against `fixtures/language-api/` copied from the spec PDF.

## Current focus (I edit this line myself before each session)
- Hour-2 deliverable from my track brief.
