# Track D — Accessibility UX and conditions (+ integration lead for `extension/src/core/`)

Owns: `extension/src/{ui,render,infer,match,core}/`. Reviews every UI PR.

Deliver, in order:
1. Hour 2: overlay shell (shadow DOM) with one ARIA live region; message bus in `src/core`.
2. Hour 8: renderers for AccessibleOutput (spoken summary, large text, "explain simpler");
   switch scanning; phrase board; profile store in browser.storage.local.
3. Hour 12: signal collectors + condition scores + suggest-then-switch with announced 10 s
   countdown and undo; debug panel showing live scores; local command matcher (Fuse.js).
4. Hour 20: voice enrollment (MFCC + DTW) if time; NVDA/ChromeVox/TalkBack passes; axe-core clean.

Done means: every core feature in the plan works by keyboard alone and by switch alone.


Also yours: the multi-condition composer `src/core/composer.ts` and its required combinations
(docs/conditions.md), the dysarthria local fast path, and the 'two failures → phrase board' rule.
Also yours: the signal table in docs/conditions.md (two-signal rule, ambiguity question,
calibration sessions), first-run onboarding, the input fallback ladder and two-level scanning,
the action menu and simplified view, and colour-swatch labels (optional fifth condition).
Also yours: playback controls UI — single-key pause/mini-menu, floating mobile button,
highlighted current sentence, and playback words in the local matcher.
