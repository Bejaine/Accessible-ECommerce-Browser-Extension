# Decisions (3–5 lines each: date, decision, why, who it affects)

## 2026-10-10 — Scaffold (integration lead, affects everyone)
- Endpoint bodies without a CLAUDE.md contract get DRAFT schemas in `shared/schemas/api/`
  so every route can validate input and output with generated Pydantic models.
- `shared/generated/` is committed; `make check` regenerates and fails if it changed.
- TS types are one file (`shared/generated/ts/index.ts`, imported as `@shared/index`); Python
  types are one module per schema in the `contracts` package (on PYTHONPATH via pytest/Makefile).
- Mock fixtures are named `<SchemaTitle>.json`; the validator and mock loaders rely on that.

## Schema freeze v1.0
Date: 10-10-2026
Decisions (the 23 items from docs/prompts/01-schema-freeze.md, applied unchanged):
1. `common.schema.json` holds `Lang` (en|hi|te), `Money` ({amount ≥ 0, currency ^[A-Z]{3}$}),
   `AsrMeta` and `SchemaVersion` (const "1.0"); used everywhere.
2. Every top-level wire object has a required `schema_version`; `additionalProperties: false` on
   every object; every `lang` field uses `Lang`.
3. Data fields are required-but-nullable; optional fields only for request options.
4. Constraints: scores/confidences 0–1; tts_rate 0.5–2.0; text_scale 1.0–3.0; scan_interval_ms
   500–5000; max_options 1–10; counts integers ≥ 0, quantity ≥ 1; timestamps `date-time`, order
   dates `date`; OCRRequest takes exactly one of image_url / image_base64.
5. ProductJSON.id is `site:native_id`; `missing` holds dot paths.
6. `availability` = {status: in_stock|low_stock|out_of_stock|preorder|unknown, text} | null.
7. `rating` = {value 0–5 normalised, count integer}.
8. `specs` keys ^[a-z0-9_]+$; SpecValue = {label, value, unit | null}.
9. `delivery.cost` is Money | null; `price` keeps {amount, currency, mrp | null}, mrp in the same currency.
10. ProductImage adds `ocr_text`; ProductJSON adds `sponsored`.
11. ProductJSON adds `reviews` {basis_count, summary_text, insights [{topic, sentiment, mentions}],
    histogram {"1".."5"} | null, items [{rating, title, text, date, verified}]} | null.
12. PageType adds orders, order_detail; PageContext adds `orders` and `secure_zone_active`.
13. ActionTarget adds `zone` (search|results|product|cart|checkout|orders|help), `state` | null,
    `colour_name` | null.
14. OrderItem.price is Money | null.
15. TurnInput: `text` | null (user's language; backend translates in /turn), `target_id`,
    `phrase_id`, `asr_meta: AsrMeta | null`; ASRResponse.asr_meta is AsrMeta; history is English.
16. TurnResponse: `intent` {name, confidence, alternatives ≤ 2 [{label, intent, actions}]};
    `workflow` {name, step, total_steps} | null (state kept by the backend per session_id);
    `confirmation` required-nullable.
17. ClientAction adds `id` and `expected_effect` {kind, detail}; `value` required-nullable.
18. Confirmation: `id` + `pending_actions` replace `action_ref` (pending actions never also in
    TurnResponse.actions); adds `read_back` {quantity, total: Money, pin_code} | null.
19. Section items are {text, kind: text|pro|con|spec|row|warning, grounding_index}; Section adds
    `table` {columns, rows, spoken} | null and `simpler` | null.
20. Grounding adds `subject_id`; `field_path` is a dot path into that subject.
21. ProductPrepareRequest drops review_texts; ReviewsSummarizeRequest is {schema_version, product};
    prepared sections are English and translated lazily.
22. ErrorResponse.code enum: rate_limited|auth_expired|upstream_unavailable|validation|not_found|
    secure_zone|internal.
23. Prefs adds `text_first`, `switch_key`, `preferred_payment` (upi|saved_card|cod | null).
Added while applying (not in the list): OrderJSON.id pattern ^ORDER_[0-9]+$ (from CLAUDE.md);
Delivery.date `format: date`; ReadBack.quantity ≥ 1; Price.currency uses the Money pattern;
request options (TTSRequest.voice, ASRRequest.sample_rate/mic_level,
VisionDescribeRequest.product_id) are optional and non-null. Generated Pydantic/TS do not enforce
OCRRequest's oneOf; JSON Schema validation does.
Affects: all tracks. Change rules (minor vs major bump) are in shared/README.md.

## 2026-10-10 — Extraction tiers and field precedence (Track B, affects C and D)
- Tiers run fastest-first: JSON-LD/meta → site adapter; a later tier overrides a field it found
  (adapters read what the user sees: price, stock, delivery, seller). `source.fields` records
  the tier per field. Anything not found is null and listed in `missing`, never guessed.
- Amazon shows the rating histogram as percentages; `reviews.histogram` counts are
  round(percent × rating.count / 100), so they carry Amazon's ±1% rounding. Say "about".
- Flipkart's CSS classes are generated, so its adapter reads structure and wording, never class
  names. Image-only colour options without a name on the page are left out of `variants`.
- `reviews.basis_count` = review items actually read from the page (not the site's total).
- Page map: ids are `t1, t2, …`, stable for the document's lifetime; max 200 targets, search and
  cart zones first; labels only, input values are never read.

## 2026-10-10 — Section summaries via Groq, verified (Track C; affects demo, B/core, slides)
- `/product/prepare` writes overview/specs/reviews with Groq (`gpt-oss-120b` for reviews,
  `gpt-oss-20b` for the others, strict JSON). The model must cite a ProductJSON field for every
  claim; code verifies each one and falls back to deterministic templates on any failure. Response
  shape is unchanged, but the call now takes ~2–4 s: call it at page load and don't block on it.
- Free tier ≈ 6k tokens per product and ~8k tokens/min per model, so about 2 *new* products per
  minute; beyond that the template answers until the limit resets. Results are cached per product.
- Demo machine needs `GROQ_API_KEY` in `.env` (see `.env.example`). Groq's free tier may use what we
  send; we send only public product data, never user data (note for the Responsible AI slide).
- SerpApi converter (`services/serpapi.py`): star "counts" are percentages (not used as a
  histogram); `basis_count` = review texts read, as for the page extractor. When the shop's
  own topic counts exist, summaries say "customers mention…" and never "based on N reviews";
  listing errors (e.g. RAM = storage) are read as written with a warning, never corrected.

## 2026-10-10 — /turn behaviour (Track C; affects D, core, A)
- One Groq tool call per turn picks a tool; tools build the answer from the page. Confidence
  ≥ 0.8 acts; 0.5–0.8 returns `actions: []` and "Did you mean X or Y?" with `intent.alternatives`
  (an alternative carries actions only when they are safe to run directly); < 0.5, or a second
  miss in a row, returns phrase chips in `output.followups`.
- Consequential actions (add to cart, quantity, cancel/return/remove, checkout) are only ever in
  `confirmation.pending_actions`; "Buy now", "Place order" and "Pay" are never pressed.
- Tapped targets (`input.target_id`) and phrase chips (`kind: phrase`, chip label as text) run
  without an LLM call. `page.secure_zone_active` → ErrorResponse `secure_zone` (HTTP 423).
- MOCK=1: `/turn` runs the real orchestrator on recorded Groq calls (`fixtures/llm/turn/`); an
  utterance with no recording gets the canned `TurnResponse.json` as before.
- Until Track A adds `bhashini.translate()`, answers stay English and say so (`output.lang: en`).

## 2026-10-11 — Photo descriptions via Gemini (Track C; affects A, D, slides)
- The main product photo is described by Gemini during `/product/prepare` (more on request via
  `/turn` "describe the photo"); descriptions are cached by image URL and returned in
  `product.images[i].description`. Outputs carry a warning that the description is AI-made.
- Numbers and printed text the VLM reads are kept only if the page confirms them (OCR text, alt
  text or title); "IP67 Rating" read off a banner is dropped until OCR (Track A) fills `ocr_text`.
- The backend downloads images only from the shops' image hosts (Amazon, Flipkart CDNs), https,
  max 4 MB. Requests set `store: false`; we send only public product photos (Responsible AI slide).
- A transcript with ASR confidence < 0.5 never acts directly in `/turn`: it asks first.

## 2026-10-11 — Schema: /extract/fallback (Track C for Track B; additive, no version bump)
- New `api/ExtractFallbackRequest` (= `LlmFallbackRequest` in extension/src/extract/llm.ts plus
  `schema_version`) and `api/ExtractFallbackResponse` {found, evidence, missing}. `found` holds
  every extractable field required-but-nullable, reusing ProductJSON's Price/Rating/
  Availability/SpecValue/Delivery; `evidence` gives per field the snippet it came from,
  copied verbatim from the request text (the backend drops any value it can't find there).
- New endpoint schemas only; no existing contract changes, so schema_version stays "1.0".

## 2026-10-11 — /extract/fallback never returns a price (Track C; affects B, core)
- Tested live on Track B's 5 saved pages: title, rating, stock, delivery, seller and some specs
  came back right, but on the Flipkart phone the model returned the bank-offer price (₹11,999)
  as the price (₹12,999), and every text check passed because that amount is on the page.
- So `found.price` is always null: price and MRP come only from JSON-LD and the site adapters.
  If they miss it, say the price couldn't be read and point to the page; never guess it.
- A value is kept only if its snippet is verbatim in the request text and the value is in that
  snippet; "name = value" highlight lines are not specs. Requests are redacted again server-side.

## 2026-10-11 — Comparison by stated preferences (Track C; affects D, core)
- Code ranks, words explain: specs are mapped to comparable features (camera MP, battery mAh,
  RAM, storage, screen, weight…) across Amazon/Flipkart/SerpApi naming; weights come only from
  what the shopper says ("camera matters, battery doesn't, under ₹20,000"), never from the
  disability profile. Missing values are "not listed", never guessed; if no listing has an
  asked-for feature the answer says so.
- `/turn` remembers, per session_id only (30 min, in memory): products opened (any site) and stated
  preferences. New tool `set_preferences`; `compare` also uses products seen earlier. No persona
  database; saving preferences across sessions would be an on-device profile + schema change.
- `/product/prepare` `comparison` section: Amazon only, from SerpApi `compare_with_similar` (other
  models' prices flagged as Amazon's); always shows the product being viewed with its rank.
