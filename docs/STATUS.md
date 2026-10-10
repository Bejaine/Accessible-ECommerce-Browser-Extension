# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | | | |
| B Page | | | |
| C Brain | `/product/prepare`: overview, specs, reviews written by Groq under a strict JSON prompt, every claim verified against ProductJSON, template fallback; images from alt/OCR text; `/reviews/summarize`; grounding check; SerpApi amazon_product → ProductJSON converter. Tested live on a real iPhone 16 listing | `/turn` (MOCK fixture); comparison section (null); image descriptions (Gemini VLM next); translation of sections (needs Bhashini MT) | None |
| D Access UX | Scaffold: overlay shell + live region, bus, profile store, `make check` | Everything else | Schemas are DRAFT until team review |

## Requests for other tracks
- C → A: `bhashini.py` needs `async def translate(text, src, tgt) -> str` (with masking) for `/turn` to
  answer in Hindi/Telugu; until then `/turn` answers in English.
- C → B/core: call `/product/prepare` at page load without waiting for it (it now takes ~2–4 s) and
  speak title + price from the page meanwhile; it returns cached sections on repeat calls.
