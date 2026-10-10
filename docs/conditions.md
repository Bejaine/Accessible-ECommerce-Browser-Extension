# Conditions spec (Track D owns; A and C implement their parts)

Four core conditions: visual (mandatory), speech, motor, ageing. Colour vision is an optional
fifth with a small, manual-only scope. Every feature must be demonstrable on its own, not a
generic "accessibility mode".

## Features per condition

- Visual — core: voice-first overlay usable with NVDA/ChromeVox/TalkBack; spoken page overview;
  specs as a short structured summary; reviews as pros, cons, verdict (with mention counts);
  plain-language comparison; spoken order summary + confirmation before paying.
  Stretch: product photo and size-chart descriptions; "where am I" page-structure command.
- Speech — core: the unclear-speech layers below; phrase chips; word prediction for typed search;
  "Did you mean X or Y?" two-option disambiguation. Stretch: personal voice enrollment; TORGO eval.
- Motor — core: full voice control; an action menu in our overlay listing the page's actions
  (from the page map) as large targets; switch scanning; one-utterance actions; no timeouts.
  Stretch: dwell-to-click; adaptive scan speed; webcam blink as a switch (MediaPipe, opt-in).
- Ageing — core: simplified view rendered from ProductJSON (no ads, sidebars or promos);
  step-by-step checkout wizard; large text; speech-speed slider; "explain simpler"; easy undo.
  Stretch: hidden-cost and inflated-MRP warnings.
- Colour vision (optional) — colour names as text on every colour swatch (from the swatch's
  title/alt/label, else VLM), colour spoken with variant choices, our own UI never relies on
  colour alone. A whole-page colour filter is off by default and never applied to product
  images (it would misrepresent the product's real colour).

We never hide or restyle the shop's own content to simplify it. Simplified layouts are our own
views built from ProductJSON, so nothing the user needs (offers, warnings, delivery terms) is lost.

## Unclear speech, including dysarthria (layers, in order)

1. Patient capture (Track A): silence timeout 2.5 s in speech mode (1.0 s default); never cut a
   user off mid-utterance; keep the audio for enrollment matching.
2. Local fast path (Track D, `src/match/`): enrolled templates (stretch) and fuzzy match against
   commands, on-screen target labels and product names. Confident match → act, no server call.
3. Bhashini ASR (Track A) → transcript plus any metadata in `asr_meta`, plus our own mic level.
4. LLM intent repair (Track C): intent + confidence, and the top two alternatives.
   ≥ 0.8 → act (with normal confirmations). 0.5–0.8 → "Did you mean X or Y?". < 0.5 → offer the
   phrase chips. Never act below 0.8.
5. Confirmation accepts a spoken yes/no, any single key, a tap, or a switch press.
6. Two failed attempts in a row → offer phrase chips; never ask to repeat a third time.
Evaluation (`eval/`): command accuracy on TORGO samples, plain ASR vs full stack. English-only
data; simulated testing, not user validation.

## Inference (on device only; passive, throttled listeners — no Web Worker)

Collect events with passive listeners, sample pointer movement at ~30 Hz, aggregate every 500 ms
with requestIdleCallback. Each signal adds weighted evidence to a 0–1 score per condition that
decays over time. A suggestion needs at least two independent signals, never one.

| Condition | Signals that work | Signals to avoid or down-weight |
|---|---|---|
| Visual | Clicks with no preceding pointerdown (activated by screen reader or keyboard); focus moving through elements with no pointer use; forced-colors / prefers-contrast; pinch zoom via visualViewport.scale > 1.5 (mobile); onboarding answer | Screen-reader browse keys (arrows, H, K): NVDA/JAWS intercept them in browse mode, so the page never sees them. devicePixelRatio: it is 2–3 by default on phones and high-DPI laptops, so it is not a zoom signal. Text selection without copying: too common to mean anything |
| Motor | Low path efficiency (straight-line ÷ actual cursor path) and frequent direction changes before clicks; overshoot near targets; same-target repeat clicks/taps under 300 ms; taps just outside a target followed by a retry; long-press when a tap was meant; high backspace rate | Keyboard-only use (shared with visual; use it only to trigger a clarifying question, not as motor evidence) |
| Speech | ASR returns little or nothing while our mic level shows the user speaking; low intent confidence; repeated retries; slow rate / long pauses | Silence with a near-zero mic level (that is a mic or environment problem: offer other input, not speech mode). Choosing text over voice (a preference, often privacy in public: offer text-first, don't infer impairment) |
| Ageing | Several together: long hesitation measured from when the page became interactive (not from load, so slow networks don't count), long hover without clicking (desktop only), slow staggered scrolling, repeated help use, large text settings | Any one of these alone (first-time users and people reading carefully look the same). Never infer age itself |
| Colour vision | None. Manual only, offered in onboarding and in overlay settings | Any behavioural guess |

Ambiguity rule: when the same evidence fits more than one condition (e.g. keyboard-only use),
ask one short question instead of guessing: "Would you like me to read things aloud, or make
buttons easier to press?"

Suggestion flow: score ≥ 0.7 with ≥ 2 signals → spoken + visual suggestion, announced 10 s
countdown, cancel by "no"/Escape/tap/switch, one-command undo. One suggestion at a time, ≥ 60 s
apart, never re-suggest a declined mode in that session. A debug panel shows live scores.

Calibration and evaluation: each teammate records short sessions of normal use and of each
simulated condition; tune weights so normal sessions trigger no suggestions. Report the false
suggestion rate on normal sessions in the evaluation slide.

## Onboarding and language (once, not on every page)

First run only: a spoken and visual prompt in all supported languages ("For Hindi say Hindi or
press 2…"), answered by voice, key or tap. Then: "Would you like me to read things aloud?" and
"Do colours ever look alike to you?". Answers seed the profile; settings stay reachable from
the overlay. Never show a modal on every page load.

## Multiple conditions at once

Conditions are independent flags. The composer (`src/core/composer.ts`) resolves them into one
mode using rules, not per-combination branches:
- Pacing takes the most restrictive value: slowest speech, longest scan interval, fewest options,
  shortest summaries.
- Output: audio if visual is active; large visuals if ageing or low vision; otherwise both.
- Input fallback ladder, always ending at one binary input so nobody is locked out:
  voice (tolerant) → keyboard / tap with prediction → phrase chips → single-switch scanning.
  The composer starts at the highest usable rung and drops a rung on repeated failure.
- Switch scanning is two-level: zones first (Search, Results, Product, Cart, Checkout, Help),
  then items inside the zone. When visual is active every highlighted item is spoken
  (auditory scanning). The switch can be Space, any key, a tap, or (stretch) a webcam blink.
- Never remove the last usable input channel.
Required combinations (these are tests, not separate code paths):
- visual + motor → auditory switch scanning.
- visual + speech → keyboard/switch with spoken feedback; phrase chips read out item by item.
- speech + motor → phrase chips driven by switch scanning.
- ageing + anything → slower TTS, 3 options per step max, a confirmation for every action.
Demo one combined persona (e.g. an older blind user with a hand tremor).

## Latency rules for speech output

- UI strings ("Add to cart", "Search", prompts, confirmations) are translated once at build time
  into `extension/src/i18n/*.json` and pre-rendered TTS where possible; runtime Bhashini calls
  only for dynamic content (product names stay untranslated, reviews, summaries).
- Free-form answers stream sentence by sentence: LLM sentence → grounding check → NMT → TTS →
  play, with the next sentence processed while the current one plays. Group short sentences so
  each TTS call carries one or two. Precomputed sections don't need streaming.

## Audio playback controls (everyone hears audio; Track A builds the player, Track D the controls)

Every spoken output (summaries, reviews, comparisons, confirmations) plays through one player,
`extension/src/audio/player.ts`, as a queue of sentences. Each sentence's audio is cached by
(text, language, voice), so replaying never calls TTS or the LLM again.

Controls, all available by voice and by a single key:
- pause / resume, stop
- repeat that (current sentence), repeat all, back one sentence
- next section, previous section
- slower / faster (client-side playbackRate, remembered in prefs)

Single key (default chosen to avoid screen-reader and browser conflicts, user-changeable,
registered through the extension commands API so it works wherever focus is):
- press while playing → pause.
- press while paused → resume; or wait 1.5 s and a spoken mini-menu is scanned
  (Resume, Repeat sentence, Repeat all, Slower, Faster, Next section, Stop) and the same key
  selects. This is the same scanning model as switch access, so one-switch users get every control.
On phones: a large floating play/pause button in the overlay with the same mini-menu; TalkBack
users activate it with a double-tap.

Voice during playback: the mic runs with echo cancellation and local VAD. Any detected speech
ducks and pauses playback, then the local matcher handles playback words (pause, repeat, stop,
slower, faster, next) without a server call; anything else goes through the normal turn.

Also: the current sentence is shown and highlighted in the overlay (helps low vision and
ageing); the controls are announced once per session ("Press K to pause, say repeat to hear it
again"); if a page change interrupts playback, offer to resume where it stopped.
