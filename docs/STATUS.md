# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | AnuvaadHub gateway (registry, RPM limiter, error mapping, MT/TTS cache, startup warm-up); `/speech/asr`, `/speech/tts`, `/translate`, `/ocr` live for en/hi/te (+ ml/ur in the gateway); live smoke test `backend/tests/smoke_language_api.py`; extension mic capture + VAD + 16 kHz WAV (`src/audio/mic.ts`), verified against live Hindi ASR; masking around MT (ZQX placeholders, live-tested) + placeholder check in `translate`; spoken-number normaliser (en/hi/Hinglish/te, lakh/crore, ranges) | Player, TTS number formatting, phrase cache, lite mode, i18n hi/te, mic not yet wired into the overlay | Shared token expires 13 Oct 10:00 IST; mic not yet tried in a real browser / Firefox Android |
| B Page | 10 real page fixtures (5 product, 4 search, 1 empty cart) from Amazon.in + Flipkart; extractor JSON-LD/meta → Amazon.in/Flipkart adapters → schema-valid ProductJSON (price/MRP, rating, stock, delivery, seller, specs with units, variants, images, Customers-say + aspect mentions + histogram + review items); search-result cards; page-type detection; page map of targets (kind/label/zone/state/swatch colour, stable ids, `resolveTarget`); LLM-fallback request builder (text only, redacted). 44 extractor tests, all fixtures validated in `make check` | LLM fallback is only a request builder (no endpoint); actuator, secure-zone detection, OrderJSON extraction, mock store still stubs | Cart-with-items, orders and order-detail fixtures need a logged-in account: save from a real browser + sanitise |
| C Brain | `/product/prepare` (Groq-written overview/specs/reviews, every claim verified, template fallback; tested on Track B's 5 real pages + a real SerpApi iPhone listing); `/reviews/summarize`; `/turn`: one Groq tool call → 10 tools (read section, answer question, compare, recommend, where am I, add to cart, press, search, go to cart, unclear), confidence rules (≥0.8 act, 0.5–0.8 did-you-mean, <0.5 chips, 2 misses → chips), confirmations for cart/risky actions, buy/pay never pressed, secure zone stops, redaction before the LLM; chips and taps skip the LLM. Tested live with 14 utterances incl. Hinglish and unclear speech; photo descriptions (Gemini, main photo on prepare, any photo via /turn), tested on 4 real product photos; comparison: spec→feature mapping across sites, ranking by stated preferences (session memory, `set_preferences`), compare with products seen earlier, Amazon comparison section from SerpApi | Translation in /turn is wired to A's `bhashini.translate` (tested with a stand-in; live Hindi run needs `models.local.json`); workflows (place/track/return/cancel) | None |
| D Access UX | Scaffold: overlay shell + live region, bus, profile store, `make check` | Everything else | Schemas are DRAFT until team review |

## Requests for other tracks
- B → C: an endpoint (e.g. `POST /extract/fallback`) + schema for LLM-fallback extraction. Request
  shape is `LlmFallbackRequest` in `extension/src/extract/llm.ts` ({url, site, missing, text,
  truncated}); response should be a partial ProductJSON plus, per field, the text snippet it came
  from (for learned adapters). Until then the fallback tier is not called.
- B → integration lead (core): call `extractPageContext(document)` at page load and on SPA URL
  changes; keep `resolveTarget(id)` for the actuator. Product sections speak from `products[0]`.
- B → D: page map targets carry `zone` for two-level scanning and `colour_name` on swatches;
  labels are capped at 120 chars.
- C → A: done — `/turn` now translates through `bhashini.translate` (thanks).
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
