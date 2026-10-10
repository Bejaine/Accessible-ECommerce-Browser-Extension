# Personal session config — copy to the repo root as CLAUDE.local.md (it is gitignored)

I am working on **Track D — Accessibility UX and conditions (integration lead)**.
@docs/tracks/track-d.md

## My scope
- I may create and edit files only in: `extension/src/{ui,render,infer,match,core}/`, `eval/`, `docs/STATUS.md`, `docs/decisions.md`, extension tests for these
- I must not edit: `backend/`, `extension/src/{extract,actuate,audio,i18n}/` — if I need something there, I use its mock and add a request to
  docs/STATUS.md under "Requests for other tracks".
- Schema changes go in a separate branch `schema/<change>` and PR, announced to the team first.

## How I work
- Branch names: `track-d/<short-feature>`, created from an up-to-date main.
- Before starting: `git switch main && git pull --rebase`, then `make types`.
- Work in small steps; after each step run the relevant tests, then `make check` before any PR.
- Default to `MOCK=1` for everything outside my track.
- At the end of each work block: update my row in docs/STATUS.md, commit, push, open a PR.
- I review every UI PR against the accessibility rules in CLAUDE.md and test with a screen reader.
- As integration lead I merge PRs, keep main green, and run the end-to-end checklist after each merge.

## Current focus (I edit this line myself before each session)
- Hour-2 deliverable from my track brief.
