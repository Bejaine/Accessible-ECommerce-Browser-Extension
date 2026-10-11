# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | AnuvaadHub gateway (registry, RPM limiter, error mapping, MT/TTS cache, startup warm-up); `/speech/asr`, `/speech/tts`, `/translate`, `/ocr` live for en/hi/te/ml (+ ur in the gateway); live smoke test `backend/tests/smoke_language_api.py`; extension mic capture + VAD + 16 kHz WAV (`src/audio/mic.ts`), verified against live Hindi ASR; masking around MT (ZQX placeholders, live-tested) + placeholder check in `translate`; spoken-number normaliser (en/hi/Hinglish/te/ml, lakh/crore, ranges); **Malayalam**: masking, numbers spoken and understood (every number up to 1 lakh round-trips), 22 UI strings + 13 recorded phrases, mock fixtures, live smoke test passes (MT, TTS, ASR of the TTS audio 0.97, OCR 0.85); Track D's onboarding, settings, matcher words and 227 UI strings in Malayalam (machine-translated, 68 hand-corrected drafts); TTS retries audio cut short by a cold voice and never caches it | Player, sources, barge-in and mic not yet wired into the overlay (requests below); real-browser and Android tests pending; Telugu strings and spoken numbers reviewed by a native speaker; Malayalam strings, numbers and real-voice clips waiting for Malayalam-speaking teammates | Mic works on Firefox Android. Malayalam TTS is slow live (4–12 s per sentence; recorded phrases and the cache cover common lines). Real-voice ASR measured (fixtures/audio: WER en 8%, hi 0%, te 19%). Token expires 13 Oct 10:00 IST, after the demo |
| B Page | 10 real page fixtures (5 product, 4 search, 1 cart) from Amazon.in + Flipkart; extractor JSON-LD/meta → Amazon.in/Flipkart/mock-store adapters → schema-valid ProductJSON on every fixture (price/MRP, rating, stock, delivery, seller, specs with units, variants, images, Customers-say, histogram, review items); search results; page-type detection; page map (stable ids, zones, swatch colours, order numbers → ORDER_n, "Deliver to …" → ADDR_n, Place-order button pinned as `t-place-order`); `/extract/fallback` request + merge (never price); **learned adapters** from fallback evidence (per site in storage.local, fill-only, never price; `completeWithFallback`); **CheckoutSummary** from visible labels (items, subtotal, delivery charge, total, PIN, selected payment, Place-order target; address as ADDR_n; `restorePlaceholders` maps ADDR_n/ORDER_n back on device); secure zone (card/CVV/OTP/password/UPI PIN fields, payment iframes; not postal "PIN code") → extraction off + `muteMicInSecureZone`; actuator `performAction` (click, React-safe fill, select, navigate, scroll; refuses secure fields; place-order/pay only with `confirmed`; verifies expected_effect); OrderJSON with `t-<action>-N` buttons; MockMart mock store (search → product → cart → checkout → place order, cancel, return). 107 Track B tests incl. mock-store end-to-end | Checkout and order extraction on real Amazon/Flipkart pages is tested only on synthetic layouts and the mock store; learned adapters only on a synthetic shop; nothing tried in a real browser yet | Logged-in cart, checkout, orders and order-detail pages must be saved from a real browser + sanitised |
| C Brain | `/product/prepare` (Groq-written overview/specs/reviews, every claim verified, template fallback; tested on Track B's 5 real pages + a real SerpApi iPhone listing); `/reviews/summarize`; `/turn`: one Groq tool call → 10 tools (read section, answer question, compare, recommend, where am I, add to cart, press, search, go to cart, unclear), confidence rules (≥0.8 act, 0.5–0.8 did-you-mean, <0.5 chips, 2 misses → chips), confirmations for cart/risky actions, buy/pay never pressed, secure zone stops, redaction before the LLM; chips and taps skip the LLM. Tested live with 14 utterances incl. Hinglish and unclear speech; photo descriptions (Gemini, main photo on prepare, any photo via /turn), tested on 4 real product photos; comparison: spec→feature mapping across sites, ranking by stated preferences (session memory, `set_preferences`), compare with products seen earlier, Amazon comparison section from SerpApi; order workflows (track, cancel, return, place order) as step machines with high-risk confirmations and page verification, tested live; short/lite answers (≤ 3 options); /vision/describe grounded for prepared products; two-option did-you-mean; translation batched (≤ 4 at once, Track A translate_many ready); backend streaming deliberately not built (see decisions) | Translation in /turn is wired to A's `bhashini.translate` (tested with a stand-in; live Hindi run needs `models.local.json`); checkout summary extraction on real pages (B) | None |
| D Access UX | Overlay shell, single live region (queued), renderers (spoken sections, large text, explain simpler), composer + required combinations, two-level switch scanning (spoken when visual), phrase board, two-failures→phrases fallback, local command matcher (dysarthria fast path), on-device signal collectors + condition scores, suggest-then-switch (10 s countdown, undo, ambiguity question), debug panel, reactive profile store, turn pipeline + confirmation card (read-back, switch = yes), local commands, speech-speed control, voice input (A's mic → /speech/asr → matcher or turn, speech mode, two misses → phrases), /product/prepare at load with section cache, SPA URL refresh, first-run onboarding page (language in all three languages, read aloud?, colours?; keys/tap/one switch/voice), overlay Settings (what's in effect, each mode marked 'you' or 'automatic', voice, text size, short answers, switch key, language, scanning, setup); voice through Track A's player (Bhashini TTS, pre-recorded phrases, device voice in demo/lite; speaks answers when read-aloud/simple mode is on; Read aloud/Stop on every answer; live speed); Back to menu; Alt+Shift+A shortcut; whole UI follows the chosen language (hi/te drafts); button audit test; persona runs on MockMart with the real backend (`make e2e`, eval/e2e/report.md: 5 of 6 complete, checkout blocked on extraction); action menu (page actions by zone, large targets), colour names on swatches (our own labels, announced on focus), simplified product view from ProductJSON (opens directly in simple mode); playback controls (floating bar with highlighted current sentence, pause/resume, repeat sentence/all, back, next/previous section, slower/faster, stop; Alt+Shift+K single key with spoken mini-menu after 1.5 s; playback voice words; hint once per session); axe-core clean (all overlay states; colour contrast still to check in a browser); inference calibration tooling (record/save sessions in dev builds, replay, `make eval-inference` report); step-by-step checkout wizard from PageContext.checkout (items, delivery, payment, review → "place my order" via C's confirmation; opens directly in simple mode); stretch: adaptive scan speed (slows when presses land right after a move, never faster than the mode), dwell to click on our own controls (opt-in in Settings, 0.8–2 s), resume where playback stopped after a page change (position kept on the device for 2 min, offered as a paused answer); menu in labelled sections + typing box with prediction; did-you-mean buttons, Try again, order-task step, automatic-continue notice; real-Chrome accessibility audit `make a11y` (clean); hold Space to talk / tap for its usual job (pages and setup), answers read aloud after a voice request, voice 'read aloud' / playback words | Live models (no keys on this machine); calibration sessions not recorded yet (recorder tested) | None |

## Integration of A + B + C (branch `integration/abc`; Track D's UI integration follows later)
- Done, tested without the overlay (`make e2e` → `eval/e2e/abc.e2e.ts`, real backend with
  MOCK=1): product questions, add to cart, place order (summary → high-risk yes → the next page
  continues and verifies), cancel and return across three pages, track, secure zone, Hindi voice
  (ASR → /turn with asr_meta → TTS), backend down → calm message → retry.
- Core (`turn.ts`, `continuity.ts`, background, content): one session id across pages and sites;
  order tasks continue on the next page ("Continue" sent on load, max 3 in a row); did-you-mean
  `alternatives` / `chooseAlternative(i)`; no turns in the secure zone, 423 stays quiet; calm
  error messages by code with `retry()` / `canRetry`; ORDER_n / ADDR_n restored before showing or
  speaking; English-only history; learned adapters on. Firefox for Android: the background relay
  no longer dies without a commands API (Track A's report).
- Fixed on the way: MockMart cancel/return reasons vs Track C's finishing step (C now chooses the
  offered reason; cancel reason optional); chips a task offered skip the LLM; ORDER_n stable across
  a tab's pages; order numbers redacted from PageContext.url; select labels without their options.
- Track D UI integration (branch `track-d/ui-integration`): done. Menu in labelled sections
  (status → answer → Ask → Quick questions → On this page → Reading → Settings); typing box with
  prediction; "Did you mean X or Y?" as two big buttons (scanned first, "first/second one" or the
  label picks it locally); "Try again" button and word; "Cancelling your order: step 2 of 3" shown
  and announced (`turn.workflow`); "Continuing your order…" on the automatic continue, with no
  resume-reading offer during a task; checkout steps kept during card entry; LAN backend in
  `host_permissions` from VITE_BACKEND and `BACKEND_HOST=0.0.0.0 make backend`.
- Checked in real Chrome (headless, web-ext, MockMart, real backend MOCK=1): price from the page →
  add to cart (confirm, "Done", cart 1) → checkout steps 1–4 → place order (high-risk read-back
  ₹ total + PIN) → yes → order page continues by itself → "Your order is placed." (MS-1003 placed)
  → typed "cancel my order" → confirmation + step 2 of 3. `make a11y`: 7 overlay states × light /
  dark / forced colours, 0 axe violations, all controls ≥ 44 px, Tab order and focus rings, names
  (eval/a11y/report.md). `make e2e`: 14 passed, all six personas complete.
- Still open: live run with real models (needs `.env` + `backend/config/models.local.json` on the
  demo machine; none on this one) and latency against the 4 s budget; NVDA / TalkBack listen-through
  and Firefox for Android on a phone; inference calibration recordings (tooling tested).

## Requests for other tracks
- D (core) answers C: after a search, the results page reads its results. When a /turn reply has
  intent `search` and a `navigate` action, the tab is marked `read_results` before the navigation
  runs (same per-tab marker as order tasks, now with a kind); the next page, if its page_type is
  `search`, sends the phrase turn `{kind: 'phrase', phrase_id: 'read the results', text: 'Read the
  results'}`. If the page doesn't navigate (single-page shop), it sends it itself after 300 ms.
- D → C: MockMart has no entry in `SEARCH_URLS`, so a voice search there fills the search box
  instead of navigating (and so isn't read out). `index.html?q={q}` on the mock store's own origin
  would let the demo show search → read the results end to end.
- D → A (FYI): the extension manifest has no `web_accessible_resources`, so recorded phrase files
  served as `chrome-extension://` URLs probably can't be loaded by an <audio> element on a shop
  page (only on the extension's own setup page). The listening cues avoid this by being inlined;
  if recorded phrases should play on shop pages, inline them or list them as web-accessible.
- D → B (page map, measured on fixtures/pages with the real URLs): Amazon.in product pages give
  196 of 200 targets in the `product` zone (breadcrumbs, warranty plans, "Customers also bought"
  links), and Flipkart puts site navigation (Home, Login, Become a Seller) in `product`. The
  overlay now curates (one entry per destination, no price/count-only labels, buttons before
  links: 200 → 93–121 entries, ~6–10 main actions), but zoning only the buy box as `product` would
  make switch scanning and the backend's view much better.
- D → A (FYI, handled in core): `browserEngines().device` pauses with speechSynthesis.pause(), which
  Chrome on Linux and Android ignore (the voice kept talking after Pause). Core now passes
  `engines: playerEngines()` (src/core/deviceVoice.ts): pause cancels the sentence, resume repeats
  it; a sentence right after cancel() waits 120 ms. Barge-in is opted in through a device setting
  "Stop the assistant by speaking" (default on for desktop, off on touch devices) and transcripts
  where `isEcho()` is true are dropped. Feel free to adopt either in `src/audio/`.
- Integration → A: Hindi/Telugu for two new UI strings in `src/ui/strings.ts`: `turn.busy`
  ("Lots of requests right now. Please try again in a moment.") and `turn.unavailable` ("I couldn't
  do that right now. You can try again, or use the phrase buttons.").
- Integration → A: done — your Firefox for Android fix is in (`browser.commands?.`, and the backend
  relay is registered first).
- B → C: done, thanks for `/extract/fallback`; the extension side is `buildFallbackRequest` /
  `applyFallback` in `src/extract/llm.ts`.
- B → integration lead (core): thanks for wiring extraction, the fallback, `performAction` and the
  mic mute. Two small changes in `core/app.ts`, both from `src/extract`:
  1. Learned adapters: at startup `await loadLearnedAdapters(browser.storage.local)`, and replace
     `applyFallback(product, await backend.extractFallback(request))` with
     `await completeWithFallback(document, product, backend.extractFallback, browser.storage.local)`
     (it builds the request itself and returns the product unchanged when nothing is missing).
  2. Before speaking or showing any backend text, `restorePlaceholders(text)` turns ORDER_n and
     ADDR_n back into the real order number / address (they never leave the device).
- B → A / core: secure zone is ready: `muteMicInSecureZone(document, mic, announce)` from
  `src/extract` mutes on entering a card/CVV/OTP/password field and unmutes on leaving; call it
  once per tab where the Mic is created. `announce('entered')` should say listening has stopped.
- B → C (answering your workflow question): order action buttons get the ids you match on —
  `t-track-N`, `t-cancel-N`, `t-return-N` for ORDER_N — on every page where B extracts orders
  (mock store now; Amazon/Flipkart order pages once we have fixtures). Other targets keep
  generic ids `t1, t2…`, so please only use the number match on `t-<action>-N` ids (a generic
  `t1` would otherwise "match" ORDER_1).
- B → C: OrderJSON ids are ORDER_n placeholders; real ids never leave the device. Order actions
  on the mock store are links labelled "Track package" / "Cancel order" / "Return item", then a
  "Reason" select and "Confirm cancellation" / "Confirm return" buttons.
- B → D: page map targets carry `zone` for two-level scanning and `colour_name` on swatches;
  labels are capped at 120 chars.
- C → A: done — `/turn` now translates through `bhashini.translate` (thanks).
- B → C (answering your checkout request): done. `PageContext.checkout` is set on checkout pages
  (mock store end to end; Amazon/Flipkart from their visible labels, not yet checked on a saved
  real page). The Place-order button is always `t-place-order` and is pinned first in `targets`.
  `delivery_address` is `ADDR_1`; the client restores it before speaking (see the core request).
- C → integration lead / D: how to call the backend and handle `/turn` (confirmations, workflows,
  errors, mock utterances) is in `docs/backend-api.md`. The client needs `extractFallback`.
- C → B (answering B's request): `POST /extract/fallback` exists (schemas
  `api/ExtractFallbackRequest/Response`; request = your `LlmFallbackRequest` + `schema_version`).
  It never fills `price` (see decisions); MOCK=1 serves `fixtures/mocks/ExtractFallbackResponse.json`.
- C → B/core: call `/product/prepare` at page load without waiting for it (it now takes ~2–4 s) and
  speak title + price from the page meanwhile; it returns cached sections on repeat calls.
- **A → integration lead (`src/core/`)**: wire voice turns as `createMic().listen({ mode })` →
  `toAsrRequest(utterance, lang)` → `backend.asr()` (background) → `TurnRequest.input` with
  `asr_meta` from the response. `mode` is `'speech'` when the speech condition is active
  (2.5 s silence timeout). One `Mic` per tab. Needs bus messages for listen/stop if the UI and
  the turn loop live in different modules.
- **A → Track B (`src/extract`)**: when a secure-zone field gains focus, call `mic.mute()`;
  when focus leaves, `mic.unmute()` (docs/safety.md). `mute()` closes the mic immediately and
  discards the audio; `listen()` then rejects with `MicError` code `secure_zone`.
- **A → Track D (`src/ui`)**: a mic button/key that calls `listen()`, a level meter from
  `onLevel` (0–1, ~10/s), and the `MicError` codes spoken via `t('mic.<code>')` (strings in
  `src/i18n/en.json`). `listen()` must be called from a user gesture (key press or tap).
- **A → Track C (`/turn`)**: `asr_meta.confidence` is always null and `alternatives` empty
  (AnuvaadHub ASR returns text only); use `mic_level` to tell silence (≈0) from unclear speech.
- **A → Track C (`/turn`)**: run `numbers.normalise_numbers(text, lang)` on the user's text before
  the LLM (and before translating it), so budgets and quantities arrive as digits ("पंद्रह से बीस
  हज़ार" → "15000 से 20000", "dedh lakh" → "150000"). Lone एक/दो/one stay words on purpose. Also
  pass the product brand to masking: `masking.mask(text, keep=[brand])` in `brain/language.py`.
- D → A: translate the UI strings in `extension/src/ui/strings.ts` (overlay, render, zone, scan,
  phrases keys; English fallbacks are there) into `extension/src/i18n/` for en/hi/te.
- D → A: `player.ts` should accept `SpokenSection[]` from `src/render` (id, heading, lines) so
  next/previous section works; `flattenSpoken()` is a stopgap for the current stub.
- D → all (schema, later): ResolvedMode could gain `confirm_every_action: boolean` (minor bump to
  1.1) so the backend knows ageing users want every action confirmed. Not urgent.
- D → A: report speech signals from the voice pipeline to the score engine: `unheard_speech`
  (ASR returned little while mic level showed speech), `low_confidence`, `speech_retry`. Never
  report silence with a near-zero mic level as speech evidence.
- D → B (done on D's side): confirmed actions call `performAction(action, { confirmed: true })`,
  safe ones `{ confirmed: false }`; failure `reason`s are spoken (not found / disabled / secure zone /
  effect not seen). Checked against `track-b/actuate-secure-zone` merged with D's work: all tests pass.
- D (core) answers B: `extractPageContext(document)` runs at load and on SPA URL changes (1 s check);
  `BackendClient.extractFallback()` (POST /extract/fallback) exists. The fallback is not called yet:
  D will wire `needsFallback → buildFallbackRequest → applyFallback` once those are on main.
- D (core) answers C: `/product/prepare` is called at load without waiting; English section phrases
  (reviews, specs, price, read page) answer from its cached sections; read-aloud users hear title
  and price from the page at once.
- D (core/ui) answers A: Speak button + level meter → `createMic().listen({ mode })` (speech mode
  when the speech condition is on) → `toAsrRequest` → `backend.asr()` → matcher or turn with
  `asr_meta`; `MicError` codes spoken via `t('mic.<code>')`. Mic is stopped on unmount.
- D → C: `backend/pyproject.toml` should list `referencing` (imported directly by
  `scripts/validate_fixtures.py`; today it only arrives via jsonschema).
- D → A: please check the Hindi and Telugu onboarding prompts in `extension/src/ui/strings.ts`
  (`onboarding.lang_prompt.hi` / `.te`) and add them to `src/i18n`; D drafted them.
- D → A (player): `src/render/speaker.ts` is a working stand-in for `player.ts` (sentence queue,
  /speech/tts with per-(text, lang) cache, device-voice fallback, live rate, stop). Please take it
  over or replace it behind the same interface (speakOutput / say / sayLines / stop / setRate).
- D → A (translations): Hindi/Telugu UI drafts are in `extension/src/ui/translations.ts`; please
  review with native speakers and move reviewed strings into `src/i18n` (they then win).
- D → all: real voice input needs `backend/config/models.local.json` + `MOCK=0 make backend` +
  `VITE_BACKEND=http://localhost:8000` in `extension/.env`; in mock mode Speak says it's unavailable.
- D → all: please record calibration sessions (3–5 min each: one normal, one simulating a
  condition) with `__asl.recordSession()` / `__asl.saveSession()` in a dev build; put the files in
  `eval/inference/sessions/` (eval/inference/README.md). The demo slide needs the false-suggestion
  rate from real sessions.
- **A → Track D / integration lead**: UI strings are in `extension/src/i18n/{en,hi,te}.json` via
  `t(key, lang)`, with pre-recorded audio from `phraseAudioUrl(key, lang)` (null → use live TTS).
  New UI text: add the key to `en.json` and tell Track A to rebuild. The local matcher should accept
  the spoken controls named in `player.controls_hint`: "रुको"/"दोबारा", "ఆపు"/"మళ్లీ".
  (D: done — the matcher accepts them, and keeps Indic vowel signs when normalising.)
- **A → integration lead (`src/core/`) / Track D: wiring the player** (all in `extension/src/audio/`):
  `sources = createSpeechSources({ tts: (text, lang) => backend.tts({schema_version:'1.0', text, lang}),
  lite: () => prefs.lite_mode, phraseUrl: phraseAudioUrl, onFallback: () => announce(t('lite.device_voice', lang)) })`;
  `player = createPlayer({ sources, rate: prefs.tts_rate, onEvent })` then `player.playOutput(turnResponse.output)`.
  Events: `sentence` (highlight it), `text-only` (no voice: show/announce the text), `rate` (save
  `prefs.tts_rate`), `end`. Controls for voice words / single key / mini-menu: `toggle, pause, resume,
  stop, repeatSentence, repeatAll, back, nextSection, previousSection, slower, faster`. Page change:
  keep `player.snapshot()` and offer `player.restore(snap)`. Barge-in: `createBargeIn({ mic, player,
  mode, onUtterance })`: send the utterance to the local matcher, else ASR → /turn; if ASR finds no
  words call `resumeAfterBargeIn()`. Start playback only after a user gesture (autoplay rules).
- D (core) answers A: the player is wired (`src/core/voice.ts` over `createPlayer` +
  `createSpeechSources`, phrase audio, onFallback → `lite.device_voice`), barge-in via
  `createBargeIn` (after the first Speak), and the mic is muted in secure zones.
- D (core) answers B: `muteMicInSecureZone(document, mic, …)` is wired; the extraction fallback
  (`buildFallbackRequest` → `extractFallback` → `applyFallback`) runs before /product/prepare on a
  real backend (not in demo mode).
- B → D: done — `PageContext.checkout` is extracted (MockMart end to end; the checkout persona in
  eval/e2e/report.md now completes).
