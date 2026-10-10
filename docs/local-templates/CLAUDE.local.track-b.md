# Personal session config — copy to the repo root as CLAUDE.local.md (it is gitignored)

I am working on **Track B — Page understanding and actions**.
@docs/tracks/track-b.md

## My scope
- I may create and edit files only in: `extension/src/extract/`, `extension/src/actuate/`, `mock-store/`, `fixtures/pages/`, extension tests for these
- I must not edit: `backend/`, `extension/src/{audio,i18n,ui,render,infer,match,core}/` — if I need something there, I use its mock and add a request to
  docs/STATUS.md under "Requests for other tracks".
- Schema changes go in a separate branch `schema/<change>` and PR, announced to the team first.

## How I work
- Branch names: `track-b/<short-feature>`, created from an up-to-date main.
- Before starting: `git switch main && git pull --rebase`, then `make types`.
- Work in small steps; after each step run the relevant tests, then `make check` before any PR.
- Default to `MOCK=1` for everything outside my track.
- At the end of each work block: update my row in docs/STATUS.md, commit, push, open a PR.
- Every extractor change is tested against saved fixtures in `fixtures/pages/`, never only against the live site.
- Never automate real purchases or returns; use `mock-store/` for checkout and return flows.

## Current focus (I edit this line myself before each session)
- Hour-2 deliverable from my track brief.
