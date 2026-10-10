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

## 2026-10-10 — AnuvaadHub wire format (Track A; affects Track D's audio consumers and Track C)
- ASR accepts WAV only (form field `audio_file`, ~20 s, < 5 MB), so the extension uploads
  16 kHz mono PCM WAV, not Opus. `/speech/asr` rejects other encodings with `validation`.
- ASR returns text only: `asr_meta.confidence` is always null and `alternatives` empty; the
  speech-mode signal comes from our own `mic_level`. Track C's intent repair must not rely on them.
- MT takes ≤ 50 words and TTS ≤ 30 words with no special characters; the gateway chunks and
  cleans automatically. TTS returns an S3 link, which the backend fetches; clients still get base64 WAV.
