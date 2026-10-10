# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | | | |
| B Page | 10 real page fixtures (5 product, 4 search, 1 empty cart) from Amazon.in + Flipkart; extractor JSON-LD/meta → Amazon.in/Flipkart adapters → schema-valid ProductJSON (price/MRP, rating, stock, delivery, seller, specs with units, variants, images, Customers-say + aspect mentions + histogram + review items); search-result cards; page-type detection; page map of targets (kind/label/zone/state/swatch colour, stable ids, `resolveTarget`); LLM-fallback request builder (text only, redacted). 44 extractor tests, all fixtures validated in `make check` | LLM fallback is only a request builder (no endpoint); actuator, secure-zone detection, OrderJSON extraction, mock store still stubs | Cart-with-items, orders and order-detail fixtures need a logged-in account: save from a real browser + sanitise |
| C Brain | `/product/prepare`: overview, specs, reviews written by Groq under a strict JSON prompt, every claim verified against ProductJSON, template fallback; images from alt/OCR text; `/reviews/summarize`; grounding check; SerpApi amazon_product → ProductJSON converter. Tested live on a real iPhone 16 listing | `/turn` (MOCK fixture); comparison section (null); image descriptions (Gemini VLM next); translation of sections (needs Bhashini MT) | None |
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
- C → B/core: call `/product/prepare` at page load without waiting for it (it now takes ~2–4 s) and
  speak title + price from the page meanwhile; it returns cached sections on repeat calls.
