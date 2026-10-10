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
- Numbers and printed text the VLM reads are kept only if page data confirms them (title, alt
  text, spec values); "IP67 Rating" read off a banner is dropped. OCR text is never used as
  confirmation: it misreads numbers and units (Track A, 2026-10-11 live findings).
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

## 2026-10-10 — AnuvaadHub wire format (Track A; affects Track D's audio consumers and Track C)
- ASR accepts WAV only (form field `audio_file`, ~20 s, < 5 MB), so the extension uploads
  16 kHz mono PCM WAV, not Opus. `/speech/asr` rejects other encodings with `validation`.
- ASR returns text only: `asr_meta.confidence` is always null and `alternatives` empty; the
  speech-mode signal comes from our own `mic_level`. Track C's intent repair must not rely on them.
- MT takes ≤ 50 words and TTS ≤ 30 words with no special characters; the gateway chunks and
  cleans automatically. TTS returns an S3 link, which the backend fetches; clients still get base64 WAV.

## 2026-10-11 — Live AnuvaadHub findings (Track A; affects Tracks B, C, D)
- OCR misreads numbers and units ("5000 mAh" → "500 mAb", "mAh" → "107"). OCR text may help
  describe an image but is never the source of a price, spec or quantity (rule 1): use ProductJSON.
- TTS takes 3–19 s per sentence (incl. the S3 download). UI phrases must come from build-time
  audio, and long answers must be spoken sentence by sentence; lite mode uses device TTS.
- A model's first call is slow (6–10 s), so the backend warms all models at startup, two at a
  time (the shared sandbox returns HTTP 500 under a burst). Timeouts: 20 s, TTS 30 s.
- Telugu ASR model infer_asr/6807… never answered (60 s); we use infer_asr/6979…353b instead
  (exact, ~1–2 s). A third, 67b8…674b, also works but made a spelling slip.

## 2026-10-11 — Mic capture in the content script (Track A; affects integration lead, B, D)
- `src/audio/mic.ts` captures in the content script with Web Audio ScriptProcessorNode (not
  AudioWorklet or a Worker, which page CSPs can block). The browser's permission prompt is
  therefore per shop origin (amazon.in, flipkart.com …), granted once per site.
- One utterance per `listen()`: energy VAD, silence timeout 1.0 s (2.5 s in speech mode), 19 s
  cap, 300 ms pre-roll; output 16 kHz mono 16-bit WAV, confirmed accepted by live Hindi ASR.
- The mic is open only while listening; `mute()` (secure zone) closes it and discards audio.

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

## 2026-10-11 — /turn with the real ASR (Track C, after Track A's feedback; affects A, D)
- Track A's ASR sends text only: `asr_meta.confidence` null, `alternatives` []. Null is treated
  as unknown (no cap); the intent confidence decides (≥0.8 act, 0.5–0.8 ask, <0.5 chips), and
  the model is told a short or broken transcript must score below 0.8.
- Empty transcript: `mic_level` < 0.05 → "I couldn't hear anything, check your microphone"
  (not counted as a miss); otherwise a miss with phrase chips. Previously HTTP 400.

## 2026-10-11 — Masking around MT (Track A; affects Track C)
- `masking.mask(text, keep=())` replaces prices, number+unit, decimals, model names and brands
  with `ZQX0, ZQX1, …`; `unmask()` restores them. Chosen by a live test: with `⟦0⟧` the MT model
  invented numbers; `ZQX0` survived en→hi, en→te and hi→en. Unmasked MT turned "Bluetooth 5.3"
  into "5" and "6.8 inch" into "6.80"; masked, every name, unit and price came through exactly.
- Pass the product's brand in `keep` (e.g. `keep=[product.brand]`): brands that are everyday
  words ("Noise", "Apple") at the start of a sentence are otherwise translated.
- `bhashini.translate` fails with `upstream_unavailable` if the MT drops a placeholder, so callers
  keep English rather than speak a sentence with a name or price missing.

## 2026-10-11 — Spoken-number normaliser (Track A; affects Track C, and D's local matcher)
- `numbers.normalise_numbers(text, lang)` turns number words into digits for en, hi (Devanagari
  and, when lang is hi, romanised), te: lakh/crore, डेढ़/ढाई/साढ़े/सवा/पौने, ఒకటిన్నర, 15k,
  native digits, 1,50,000. `parse_number(text, lang)` returns the value of a lone number.
- A wrong number is worse than a word left alone: lone एक/दो/ek/do/one/ఒక stay words ("डाल दो" is
  "put it", "the cheaper one"), lone multipliers stay ("lakhs of reviews"), side-by-side numbers
  are not added ("two three days"), and digits are never reformatted.
- Ranges share the multiplier: "पंद्रह से बीस हज़ार" → "15000 से 20000", never backwards.
