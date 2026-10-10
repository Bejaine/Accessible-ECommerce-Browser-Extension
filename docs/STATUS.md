# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | | | |
| B Page | 10 real page fixtures (5 product, 4 search, 1 empty cart) from Amazon.in + Flipkart; extractor JSON-LD/meta → Amazon.in/Flipkart adapters → schema-valid ProductJSON (price/MRP, rating, stock, delivery, seller, specs with units, variants, images, Customers-say + aspect mentions + histogram + review items); search-result cards; page-type detection; page map of targets (kind/label/zone/state/swatch colour, stable ids, `resolveTarget`); LLM-fallback request builder (text only, redacted). 44 extractor tests, all fixtures validated in `make check` | LLM fallback is only a request builder (no endpoint); actuator, secure-zone detection, OrderJSON extraction, mock store still stubs | Cart-with-items, orders and order-detail fixtures need a logged-in account: save from a real browser + sanitise |
| C Brain | `/product/prepare` (Groq-written overview/specs/reviews, every claim verified, template fallback; tested on Track B's 5 real pages + a real SerpApi iPhone listing); `/reviews/summarize`; `/turn`: one Groq tool call → 10 tools (read section, answer question, compare, recommend, where am I, add to cart, press, search, go to cart, unclear), confidence rules (≥0.8 act, 0.5–0.8 did-you-mean, <0.5 chips, 2 misses → chips), confirmations for cart/risky actions, buy/pay never pressed, secure zone stops, redaction before the LLM; chips and taps skip the LLM. Tested live with 14 utterances incl. Hinglish and unclear speech; photo descriptions (Gemini, main photo on prepare, any photo via /turn), tested on 4 real product photos; comparison: spec→feature mapping across sites, ranking by stated preferences (session memory, `set_preferences`), compare with products seen earlier, Amazon comparison section from SerpApi | Translation in /turn (English until A adds `translate()`); workflows (place/track/return/cancel) | None |
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
- C → A: `bhashini.py` needs `async def translate(text, src, tgt) -> str` (with masking) for `/turn` to
  answer in Hindi/Telugu; until then `/turn` answers in English.
- C → B (answering B's request): `POST /extract/fallback` exists (schemas
  `api/ExtractFallbackRequest/Response`; request = your `LlmFallbackRequest` + `schema_version`).
  It never fills `price` (see decisions); MOCK=1 serves `fixtures/mocks/ExtractFallbackResponse.json`.
- C → B/core: call `/product/prepare` at page load without waiting for it (it now takes ~2–4 s) and
  speak title + price from the page meanwhile; it returns cached sections on repeat calls.
