# Kickoff prompts (each teammate, first session after the scaffold is merged and schemas frozen)

Start every session the same way, then use your track's prompt.

## Session opener (everyone, every session)
Tell me which track I'm on and the non-negotiable rules that matter most for my track. Then read
docs/STATUS.md and `git log --oneline -15`, and summarise what changed since my last session
that affects my track.

## Track A
Build the hour-2 and hour-8 deliverables from my track brief. Start with the language-API gateway:
model registry, per-model rate limiter, error mapping and MOCK fixtures in
fixtures/language-api/. Write tests first for the registry and limiter. Then the speech,
translate and ocr routes, then mic capture with VAD in extension/src/audio/. Stop after each
of those three parts, run the tests, and show me the result before continuing.

## Track B
Build the hour-2 and hour-8 deliverables from my track brief. I have saved page HTML into
fixtures/pages/. First write the JSON-LD/meta extractor with tests against those fixtures, then
the Amazon.in and Flipkart adapters, then the page map of interactive targets. Every extraction
must validate against ProductJSON. Stop after each part, run the tests, and show me the result.

## Track C
Build the hour-2 and hour-8 deliverables from my track brief. Start with /product/prepare in MOCK
mode, then the /turn orchestrator with one LLM call using function calling, returning
AccessibleOutput that passes a grounding check. Use recorded fixtures for every LLM test.
Stop after each part, run the tests, and show me the result.

## Track D
Build the hour-2 and hour-8 deliverables from my track brief. Start with the overlay shell and the
announce live region, then the renderers for AccessibleOutput (spoken summary, large text,
explain simpler), then the composer in src/core/composer.ts with tests for every required
combination in docs/conditions.md. Stop after each part, run the tests, and show me the result.

## Ending a work block (everyone)
Run `make check` and fix anything failing in my track. Update my row in docs/STATUS.md (works for
real / still mocked / blockers / requests for other tracks). Commit with a clear message, push
my branch, and give me a PR title and description I can paste.

## Picking up a teammate's merged work
`git switch main && git pull --rebase && make types`, then: "Switch my mock for <feature> to the
real implementation, run the integration path end to end, and list anything that doesn't match
the contract."
