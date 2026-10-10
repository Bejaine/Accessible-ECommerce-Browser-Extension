# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | AnuvaadHub gateway (registry, RPM limiter, error mapping, MT/TTS cache, startup warm-up); `/speech/asr`, `/speech/tts`, `/translate`, `/ocr` live for en/hi/te (+ ml/ur in the gateway); live smoke test `backend/tests/smoke_language_api.py`; extension mic capture + VAD + 16 kHz WAV (`src/audio/mic.ts`), verified against live Hindi ASR; masking around MT (ZQX placeholders, live-tested) + placeholder check in `translate`; spoken-number normaliser (en/hi/Hinglish/te, lakh/crore, ranges) | Player, TTS number formatting, phrase cache, lite mode, i18n hi/te, mic not yet wired into the overlay | Shared token expires 13 Oct 10:00 IST; mic not yet tried in a real browser / Firefox Android |
| B Page | Real page fixtures (5 product, 4 search, 1 cart) + extractor: JSON-LD/meta → Amazon.in/Flipkart/mock-store adapters → schema-valid ProductJSON; search results; page map (stable ids, zones, swatch colours; order numbers replaced by ORDER_n); `/extract/fallback` request + merge (`needsFallback`/`buildFallbackRequest`/`applyFallback`, never price); secure-zone detection (`isSecureElement`, `watchSecureZone`, `muteMicInSecureZone(doc, mic)`; extraction returns nothing while active); actuator `performAction` (click / React-safe fill / select / navigate / scroll, refuses secure fields and place-order/pay without `confirmed`, verifies expected_effect); OrderJSON extraction with ORDER_n placeholders (`resolveOrderId` maps back on device); MockMart mock store (search, product, cart, checkout, orders, order detail, cancel + return flows). 140 extension tests incl. mock-store end-to-end | Learned adapters from fallback evidence; OrderJSON extraction for real Amazon/Flipkart order pages (no fixtures) | Cart-with-items / orders / order-detail fixtures for real sites need a logged-in account: save from a real browser + sanitise |
| C Brain | `/product/prepare` (Groq-written overview/specs/reviews, every claim verified, template fallback; tested on Track B's 5 real pages + a real SerpApi iPhone listing); `/reviews/summarize`; `/turn`: one Groq tool call → 10 tools (read section, answer question, compare, recommend, where am I, add to cart, press, search, go to cart, unclear), confidence rules (≥0.8 act, 0.5–0.8 did-you-mean, <0.5 chips, 2 misses → chips), confirmations for cart/risky actions, buy/pay never pressed, secure zone stops, redaction before the LLM; chips and taps skip the LLM. Tested live with 14 utterances incl. Hinglish and unclear speech; photo descriptions (Gemini, main photo on prepare, any photo via /turn), tested on 4 real product photos; comparison: spec→feature mapping across sites, ranking by stated preferences (session memory, `set_preferences`), compare with products seen earlier, Amazon comparison section from SerpApi; order workflows (track, cancel, return) as step machines with high-risk confirmations and page verification, tested live | Translation in /turn is wired to A's `bhashini.translate` (tested with a stand-in; live Hindi run needs `models.local.json`); place-order workflow (needs a checkout summary in PageContext) | None |
| D Access UX | Scaffold: overlay shell + live region, bus, profile store, `make check` | Everything else | Schemas are DRAFT until team review |

## Requests for other tracks
- B → C: done, thanks for `/extract/fallback`; the extension side is `buildFallbackRequest` /
  `applyFallback` in `src/extract/llm.ts`.
- B → integration lead (core): call `extractPageContext(document)` at page load and on SPA URL
  changes. If `needsFallback(products[0])` is non-empty, send `buildFallbackRequest(document,
  product)` to `/extract/fallback` (needs a `extractFallback` method in `core/backend.ts`) and
  replace the product with `applyFallback(product, res)`. Run TurnResponse.actions with
  `performAction(action)`; run Confirmation.pending_actions only after the user's yes, with
  `performAction(action, { confirmed: true })`, then speak the result (`ok`/`reason`).
- B → A / core: secure zone is ready: `muteMicInSecureZone(document, mic, announce)` from
  `src/extract` mutes on entering a card/CVV/OTP/password field and unmutes on leaving; call it
  once per tab where the Mic is created. `announce('entered')` should say listening has stopped.
- B → C: OrderJSON ids are ORDER_n placeholders; real ids never leave the device. Order actions
  on the mock store are links labelled "Track package" / "Cancel order" / "Return item", then a
  "Reason" select and "Confirm cancellation" / "Confirm return" buttons.
- B → D: page map targets carry `zone` for two-level scanning and `colour_name` on swatches;
  labels are capped at 120 chars.
- C → A: done — `/turn` now translates through `bhashini.translate` (thanks).
- C → B: for place-order we need the checkout page's summary in PageContext: items with quantity
  and price, order total (Money), delivery PIN code, and the "Place order" target. That is a
  schema addition (C will draft the schema PR); B extracts it. Until then place-order isn't built.
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
