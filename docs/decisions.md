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

## 2026-10-11 — Actuator safety, secure zone and orders (Track B; affects A, C, core)
- `performAction` refuses to click controls labelled place order / pay / buy now / confirm
  purchase unless called with `{ confirmed: true }` (only for Confirmation.pending_actions after
  the user's yes), never fills a secure field, and returns {ok, performed, verified, reason}.
- Secure zone = password/cc-*/one-time-code fields, card/CVV/expiry/OTP/UPI-PIN wording, and
  payment-gateway/3-D Secure iframes. "PIN code" (postal) is not secure. While focus is inside,
  `extractPageContext` returns no products or targets and `secure_zone_active: true`.
- Order numbers become ORDER_n everywhere they could leave the device (OrderJSON.id, target
  labels, LLM text); `resolveOrderId()` maps back locally for reading aloud.
- Mock store (MockMart) runs on localhost with `<meta name="asl-mock-store">`; a "Return
  requested" status maps to OrderStatus `returned` (the enum has no requested state).

## 2026-10-11 — Order workflows: track, cancel, return (Track C; affects B, D, core)
- Step machines in `brain/workflows.py`, state per session_id; `TurnResponse.workflow` =
  {name, step, total_steps}. Track: choose order → status. Cancel: choose → confirm → verify.
  Return: choose → reason → confirm → verify. The LLM only fills slots (order, reason, stop).
- Cancel/return are only ever `confirmation.pending_actions` with risk "high"; after the user
  confirms, the next /turn reads the new page: a "Cancel checked items"/"Submit return" button →
  one more high-risk confirmation; the order showing cancelled/returned → done.
- Several orders: the button is matched to the order by the number in its target id
  (t-cancel-1 ↔ ORDER_1); otherwise we ask the user to open the order's page (B: please keep
  that id convention, or tell us another way to tie a button to its order).
- An item price with quantity > 1 is read "as listed" and never read back as a total (the page
  doesn't say per item or in total). Step limit 8 turns; "stop" ends a task at any point.

## 2026-10-11 — /turn with Track A's masking and numbers (Track C; affects A, D)
- The user's words go through `numbers.normalise_numbers` before and after translation ("dedh
  lakh" → 150000) so budgets and quantities reach the model as digits.
- Translation passes the page's product brands to `masking.mask(keep=...)`; a translation that
  lost a placeholder (name, unit, price) is rejected and the answer stays English (`lang: en`).
- Confirmations are short sentences with at most one name or price each ("Add Zentra Pulse 5G to
  your cart? Quantity 1, price ₹17,999."); the colour is its own line. Live Hindi showed several
  masked names in one sentence come back in a shuffled word order.
- Demo: the backend warms the language models at startup (~25 s); start it a minute early.

## 2026-10-11 — Schema: checkout summary (Track C for place-order; affects B, D, core)
- New `CheckoutSummary` {id CHECKOUT_n, items [{title, quantity, price}], subtotal,
  delivery_charge, total, delivery_pin_code, delivery_address (ADDR_n placeholder),
  payment_method (selected), place_order_target_id, missing}; `PageContext.checkout` holds it on
  checkout pages. Grounding may name a CheckoutSummary id as subject.
- `checkout` is OPTIONAL (not required-but-nullable) so B's existing PageContext code keeps
  compiling; schema_version stays "1.0". Team: bump to 1.1 later if we want strict versioning.
- B: please extract it on Amazon/Flipkart checkout pages (logged-in account; save + sanitise).
  Without `total` and the Place-order target, the backend refuses to place an order.

## 2026-10-11 — Place order (Track C; affects B, D, core)
- `order_task` with task "place" on a checkout page: reads `PageContext.checkout` aloud (items,
  delivery charge, ADDR_n, payment) and returns ONE high-risk Confirmation "Place this order?
  Total ₹X. Delivery PIN N." with read_back {quantity, total, pin_code}; the Place-order click is
  only its pending action. Next page with the order "placed" → "Your order is placed."
- Refused (nothing offered) without a total, the Place-order target or a selected payment
  method. Warns when the page's payment differs from prefs.preferred_payment. Pressing the
  button directly is refused. Payment details are always entered by the user (secure zone).

## 2026-10-11 — /turn translates an answer's lines in parallel (Track C; affects A)
- All lines of one answer (summary, headings, items, follow-ups, warnings) are translated
  concurrently through `bhashini.translate`; one at a time, a 20-line answer cost 20 round trips.
  Still all-or-nothing: if any line fails, the whole answer stays English (`lang: en`).
- At most 4 MT requests at once, each distinct line once (Track A: the sandbox allows a burst
  of 12 per model then ~0.8/s, and returned 500s for ~20 at once). When Track A's
  `bhashini.translate_many` lands it is used automatically (a few packed requests per answer);
  masking and the lost-placeholder check still apply per line.
- The user's words are redacted BEFORE translation (they were translated first, so a card number
  or OTP said in Hindi reached the MT service); placeholders survive masking and translation.
- MT turns ": " into a visarga ("रंगः"); we put the colon back, at most as many as the English
  had. `fixtures/mocks/TurnResponse.json` now has the Hindi prompt equal to the Hindi summary.

## 2026-10-11 — Short answers, photo grounding, did-you-mean, streaming (Track C; affects D, core)
- `prefs.verbosity == "short"` or `prefs.lite_mode`: at most 3 items per section, 3 follow-up chips
  and 4 table rows (docs/conditions.md: 3 options per step). Summaries are never cut: they are
  already ≤ 2 sentences and cutting lost key facts (delivery date, read-backs). The cache keeps the
  full sections; /product/prepare and /turn shorten per request.
- `/vision/describe` with the `product_id` of a prepared product grounds its answer in
  `images[i].description`. Without one there is nothing to cite: only visual description is kept
  (numbers and printed text dropped), marked AI-made. This is the one ungrounded output.
- "Did you mean X or Y?": when the model gives no different second meaning, the sound-alike command
  is offered ("a cart" → Open the cart, or Add to cart?); consequential choices carry no actions.
- No backend streaming (track brief item, decided not to build): /turn answers are built by our
  tools, not free-form LLM prose, grounding is already per sentence, and a turn returns in ~1–2 s.
  The slow part is TTS (Track A), which `player.ts` already plays sentence by sentence. Streaming
  would need a new endpoint, an event schema and a client rewrite for little gain. Revisit only if
  free-form LLM answers are added.

## 2026-10-11 — Review headings "Good points" / "Drawbacks" (Track C; affects A, D)
- Review sections are headed "Good points", "Mixed opinions" and "Drawbacks" (were "Pros"/"Cons",
  which MT rendered as "प्रो"/"विपक्ष", "ప్రోస్"/"కాన్స్" out of context, Track A's live run).
  Older recorded LLM answers saying "Pros"/"Cons" are renamed in code.
- Track A's `bhashini.translate_many` (track-a/tts-speech) is picked up automatically by
  `brain/language.py` once merged: ~2 MT calls per answer instead of ~14.

## 2026-10-10 — Composer rules (Track D; affects A's player, C's option counts)
- Input ladder voice → keyboard → phrase → switch. Speech makes voice unreliable as a *starting*
  rung (speech alone starts at keyboard with prediction); motor makes keyboard unreliable;
  `text_first` skips voice as a preference. The switch is always the last rung.
- Pacing = most restrictive: 3 options and short summaries for ageing; scan interval 1500 ms base,
  2000 motor, 2500 visual/ageing. Speech rate is the user's: turning ageing on sets a 0.85
  *starting* rate once (never faster than the user's own), then "slower"/"faster" or the
  Speech speed buttons change it in 0.1 steps (0.5–2), saved in prefs. (Changed 2026-10-11.)
- Output: visual → audio (+ large_text with ageing or text_scale > 1); ageing → audio + large_text.
- "Confirm every action" for ageing isn't in ResolvedMode 1.0; `confirmEveryAction()` covers it
  until a minor schema bump adds a field.

## 2026-10-10 — Local matcher scoring (Track D)
- The brief named Fuse.js, but its substring scoring let short words match inside long ones
  ("no" scored 0.90 against "Novix A15…") and missed misheard words ("add to card" 0.75).
  `src/match` uses word-level edit distance scaled by coverage instead; no dependency.
- Acts locally only at confidence ≥ 0.8 and ≥ 0.1 ahead of a different runner-up; otherwise
  passes to /turn with the top two candidates. Products match by short name (brand + model).

## 2026-10-10 — Inference scoring (Track D)
- Signals add decaying evidence (half-life 3 min) to independence groups; score = 1 − Π(1 − group).
  Groups cap at 0.5 (ageing 0.35), so a suggestion structurally needs 2 independent groups
  (ageing 3). Keyboard clicks + focus moves without a pointer are one group ("keyboard"): alone
  they ask "read aloud, or easier to press?" instead of suggesting either.
- Weights and thresholds in `src/infer/scores.ts` / `collectors.ts` (TUNING) are first guesses;
  calibrate with recorded normal sessions (`__asl.signals()`) before the demo.

## 2026-10-11 — Turn pipeline in the content script (integration lead; affects B, C)
- Phrase chips, suggestion chips, scan selections and utterances go through `src/core/turn.ts`:
  TurnRequest → backend (via the background script) → render output → run `actions`, or hold
  `confirmation.pending_actions` until Yes / one switch press (Escape or "no" cancels).
- yes / no / repeat / help / slower / faster / undo are handled on the device (no server call).
- Mock mode picks the fixture that fits the request and appends a "demo data, not from this
  page" warning to every answer, so fixture facts are never mistaken for the open page.

## 2026-10-11 — Device voices and privacy (Track D; affects A, demo, Responsible AI slide)
- Measured on Chrome 149 / Linux: without flags it offers 19 Google *online* voices (English,
  Hindi; no Telugu); with `--enable-speech-dispatcher` it offers none, so that flag is not used.
  Firefox uses on-device voices via speech-dispatcher (e.g. Piper, eSpeak incl. Telugu).
- The speaker picks a voice per language: on-device first, then online, Indian variant preferred.
  A language with no voice is not read with another language's voice; the user is told once and
  the text stays on screen and in the live region.
- Online voices send the spoken text to Google: say so on the Responsible AI slide; Bhashini TTS
  (real backend) or Firefox avoids it. Addresses are never spoken through them (only ADDR_n
  placeholders reach the overlay today).

## 2026-10-11 — Numbers are spoken as words (Track A; affects C, D)
- Live, the Hindi and Telugu TTS voices read digits in English ("सेवेंटींथ…", "బైవ్ థౌసండ్") and
  ₹ is rejected, so `bhashini.tts` first calls `numbers.speakable(text, lang)`: prices with the
  currency word (and paise), numbers in the Indian system, decimals, units in the listener's
  script; PIN codes, phone/order numbers and leading zeros digit by digit; names (S24, 5G) kept.
- Verified by TTS → ASR: Hindi and Telugu now say "सत्रह हज़ार नौ सौ निन्यानवे रुपये" /
  "పదిహేడు వేల … రూపాయలు". Telugu TTS took ~16 s for one long sentence: speak short sentences.
- Text shown on screen keeps the digits; only the audio uses words. Telugu forms were written
  by us and then reviewed by a native speaker (2026-10-11): no changes needed.

## 2026-10-11 — UI strings and pre-recorded phrases (Track A; affects D, core)
- UI strings live in `extension/src/i18n/{en,hi,te}.json`; `t(key, lang)` falls back to English.
  `scripts/build_phrases.py` machine-translates missing keys and records each string as 16 kHz
  audio. MT was wrong for several UI strings (e.g. "your colours look alike", "भाषण" for speech,
  "they added" in Telugu), so hi/te strings are hand-reviewed and never overwritten by the script.
- `phraseAudioUrl(key, lang)` (src/audio/phrases.ts) returns the recording only if it was made from
  the current text; otherwise null and the caller uses live TTS. Add new UI strings to en.json
  and ask Track A to rebuild (needs tokens). Only the phrases in `i18n/prerecord.json` are
  recorded (13 short/onboarding phrases, 2.2 MB as 16 kHz WAV, ~32 KB/s); long messages are
  spoken live, or by the device voice in lite mode.
- The spoken control words in `player.controls_hint` are 'रुको'/'दोबारा' and 'ఆపు'/'మళ్లీ': the
  local matcher (Track D) must accept them. Telugu strings reviewed by a native speaker
  (2026-10-11): no changes needed.

## 2026-10-11 — translate_many: an answer's lines in few MT calls (Track A; affects Track C)
- `bhashini.translate_many(lines, src, tgt)` returns the same length and order, or raises
  ApiError (callers keep the whole answer in one language). Cached lines are free, duplicates
  are translated once, the rest are packed as a numbered list of ≤ 50 words per request.
- Chosen by a live test: newline and "||" separators were merged or mangled, and a marker word
  kept its count but moved into the middle of a sentence (silently wrong lines); numbered items
  stayed whole and in order (en→hi, en→te). Every packed reply is still verified (markers 1…n
  in order, each item keeps its placeholders); a failed batch is re-translated line by line.
- Live: a 14-line reviews answer took 2 calls per language (was 14), 0.4 s hi / 1.1 s te.

## 2026-10-11 — Player, audio sources and barge-in (Track A; affects D, core, C)
- `player.ts` plays an AccessibleOutput segment by segment (summary, headings, items, spoken
  tables), prefetching the next segment's audio: this is the sentence-by-sentence streaming
  (Track C decided /turn itself does not stream). Replays come from cache, never a new TTS call.
- Audio per segment (`sources.ts`): pre-recorded phrase → cache → device voice in lite mode →
  server TTS (25 s) → device voice on failure (announced once; device-only for 1 min after two
  failures) → text only if the device has no voice for the language. Never an English voice for
  Hindi/Telugu.
- Barge-in (`bargeIn.ts`): speech pauses playback; the utterance goes to the matcher or /turn.
  Not during device-voice segments: the OS plays them, so echo cancellation may not remove them
  and the mic could hear our own voice. Keys/taps always work.

## 2026-10-11 — Core now uses Track A's player; speed steps 0.25 (Track D; affects A, B)
- All speech goes through `src/audio/player.ts` (rule 12) via `src/core/voice.ts`, an adapter
  that adds prompts over a paused/playing answer (snapshot/restore), multilingual line queues
  (setup page) and following `prefs.tts_rate`. Track D's interim speaker is removed.
- Speech speed moves in 0.25 steps (the player's), 0.5–2; simple mode starts at 0.75× (was 0.85×).
- Secure zone: `muteMicInSecureZone(document, mic, …)` mutes the mic and announces it.
- Extraction fallback runs only against a real backend: the mock describes the fixture phone,
  and merging it into a real product would invent facts (rule 1).
- Barge-in starts only after the user has used Speak once, so the mic permission prompt never
  appears unexpectedly during playback.

## 2026-10-11 — Checkout summary and learned adapters (Track B; affects C, D, core)
- `PageContext.checkout` is read from visible labels ("Order total", "Price (2 items)",
  "Delivery charges FREE", a checked payment radio, "Place your order"), not per-site selectors,
  so it works on Amazon, Flipkart and the mock store alike. Unknowns go to `missing`; with no
  total or Place-order target C refuses to place. The button is `t-place-order`, pinned in targets.
- Addresses are personal: only `ADDR_n` leaves the device, also in "Deliver to …" labels.
- Learned adapters: a fallback evidence snippet is located in the page and stored as a selector
  per site (storage.local). Rules only fill empty fields and never read a price.

## 2026-10-11 — ASR on real voices (Track A; affects C)
- 9 clips of a team member (fixtures/audio, 16 kHz): mean WER en 8%, hi 0%, te 19%; every spoken
  budget ("twenty thousand", "बीस हज़ार", "ఇరవై వేల") came out as 20000; 0.5–0.7 s per clip.
  Telugu errors were spellings of English loanwords (cart → "కాట్లో"), not meaning changes.
- ASR heard "Add this to cart" as "Add this two cart". The number normaliser now leaves a lone
  small English number word as a word (to/two, for/four), so it can't become "add 2 to cart";
  "two thousand" etc. still convert. Track C: expect such homophones in English transcripts.

## 2026-10-11 — `make ext` Chrome on Linux: voices restored (Track D; affects everyone testing)
- Measured: web-ext's default flag `--disable-component-extensions-with-background-pages` leaves
  Chrome with 0 voices (Chrome's speech voices are a component extension); without it, 19.
  `extension/dev/chrome-linux.sh` launches Chrome without that one flag (Linux only).
- `--test-type` hides the "unsupported command-line flag" bar; web-ext's
  `--disable-blink-features=AutomationControlled` stays (otherwise navigator.webdriver is true and
  shops may block the session as a bot).

## Motor and playback stretch features (Track D)
- Adaptive scanning only slows down from the composer's `scan_interval_ms` (late press = within
  max(300 ms, 15 %) of a move → +20 %, up to 5 s) and comes back after 5 unhurried presses; a
  press still selects what is highlighted, so behaviour stays predictable.
- Dwell to click works only on our overlay's controls, never the shop's page; it is a device
  preference (`DevicePrefs.dwellMs`, off by default), not part of the Profile contract.
- Resume after a page change: the answer's player snapshot sits in `browser.storage.local` while it
  plays (cleared on end/stop, 2-minute limit, same site only) and is offered paused; nothing
  autoplays.

## 2026-10-11 — Integration of A + B + C (affects everyone, especially D and C)
- Session: one `session_id` per browser session from the background script (storage.session),
  renewed after 30 idle minutes like the backend; pages no longer make their own.
- Order tasks across pages: before a workflow step's actions run, the tab is marked; the next page
  sends a "Continue" turn on load. If the page survives the step, it continues itself. At most 3
  automatic "Continue" turns in a row.
- ORDER_n is stable across a tab's pages (tab sessionStorage holds only order numbers the shop
  showed in that tab), and order numbers are redacted from PageContext.url.
- Errors are spoken from the code, never the backend's text; network failures are retryable.
- Chips an order task offered (reasons, orders) skip the LLM, like the fixed chips. When the
  user picked an offered return reason, the finishing confirmation selects it on the page.

## 2026-10-11 — Menu layout and colour tokens (Track D; affects anyone adding overlay UI)
- The overlay menu is a fixed order of labelled sections (`src/ui/menu.ts`): status (confirmation,
  suggestion, did-you-mean, try again, order step) → answer → Ask → Quick questions → On this page →
  Reading → Settings. New controls go into a section, never loose into `overlay.controls`.
- While an answer, the simplified view or the checkout steps are open, only status + Ask remain
  (`.asl-answering`); "Back to menu" restores the rest.
- Colours only via tokens on `.asl-root` (`--asl-fg/bg/muted/accent/tile/line/line-strong`), light
  and dark measured: text ≥ 6.4:1, control borders ≥ 4.9:1. Under forced colours every overlay
  button uses system button colours (one `!important` rule in overlay.ts).
- Did-you-mean options appear once (two big buttons; not repeated as follow-up chips); the
  question is announced only if the answer's summary didn't already ask it.

## 2026-10-11 — Groq per-minute budget (Track C; affects the demo)
- Live test hit Groq's free-tier limit of 8k tokens/min per model (not the daily one): opening a
  product (3 summary calls) plus speaking used up both models and /turn returned 503.
- Fixes: /turn tool definitions trimmed (shared fields explained once in the system prompt):
  a turn costs ~2k tokens instead of ~5k. Background summaries use only gpt-oss-20b (template if
  it is limited); /turn uses gpt-oss-120b first, then 20b, so page loads never starve speaking.
- Limits are per Groq account, not per key: rotating keys of one account gains nothing, and
  rotating several accounts would circumvent Groq's limits, so we don't. Chips, taps and
  confirmations never call Groq. Order buttons are matched only by `t-<action>-N` ids (Track B).

## 2026-10-11 — Playback fixes and the settings page (Track D)
- Device voice: pause = cancel + repeat the sentence on resume (speechSynthesis.pause() is a no-op on
  Chrome Linux/Android). Core supplies the engine; Track A's player is unchanged.
- The speaker reports its own state: an answer paused behind a finished prompt is still "paused"
  (the playback bar keeps Resume), and playback controls act on the answer, not the prompt.
- Barge-in is a device preference (desktop on, phones off), per Track A's echo finding.
- Settings is a page in the panel (Back to menu, "Right now" summary, sections Modes / Voice /
  Text and language / Pointer and switch, then Run setup again), not an inline drop-down.

## 2026-10-11 — Space to speak, simple mode by itself, curated actions, features note (Track D)
- Space starts/stops listening when nothing else needs it: not while typing, not on a control that
  Space presses (button, link, checkbox…), not during switch scanning, and not while a confirmation
  or suggestion waits (Space = yes there). A setting turns it off (it replaces Space-to-scroll).
- Once simple mode is on (accepted suggestion or chosen), its accommodations apply by themselves:
  text 1.25× (once per device; restored when the mode is turned off, a later user choice is kept),
  and product/checkout pages open the panel into the simple view / checkout steps without moving
  focus.
- "Actions on this page" is curated client-side (src/ui/pageActions.ts): one entry per destination,
  most descriptive label, no labels without letters / price / rating-count noise; main actions
  (controls in product/cart/checkout/orders) first, the rest under "More on this page". The page
  map itself is unchanged (matcher and backend still see all targets).
- A corner note lists the features that are on by their feature names ("Read-aloud mode"), never
  conditions or people, marks automatic ones, offers Change and Hide; hidden while the panel is open.

## 2026-10-11 — Space: hold to talk, tap for its usual job (Track D; everyone testing voice)
- Hold Space (≥ 400 ms) anywhere, also on the setup page: what is being read pauses, the mic
  listens while Space is held ("speech" mode, patient silence), letting go sends what was said.
  Nothing heard → the reading carries on. Playback words ("pause", "next", "repeat", "read aloud")
  act on what was being read, locally.
- Tap Space: yes to a pending confirmation / the switch answer to a suggestion (when Space is the
  switch key), presses a focused button, steps through choices on the setup page; on the page
  itself it starts hands-free listening (ends on silence; a second tap stops it).
- Not while typing; during switch scanning Space is only the switch (resting on a switch never
  starts talking). Setting "Hold Space to talk" turns it off.
- After the user has spoken once, answers and prompts are read aloud for the rest of the tab's
  session (assistant voice "auto"); the panel opens (without focus) to show the answer.
- "Always listen while it reads" (barge-in) is now off by default: holding Space is the dependable
  way to talk over an answer; continuous listening needs headphones.

