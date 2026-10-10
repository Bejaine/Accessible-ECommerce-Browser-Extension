# Schema freeze prompt (driver runs once, on branch schema/freeze)

Before running: in the freeze meeting, go through the "Decisions" list below. Change any item the
team disagrees with, then copy the final list into docs/decisions.md as the "Schema freeze v1.0"
entry. Paste everything below the line into Claude Code at the repo root.

---
We are freezing the data contracts. CLAUDE.md's "Contracts" section and docs/decisions.md
("Schema freeze v1.0") are the source of truth. Plan first: list every schema file, field and
fixture you will change, and every piece of existing code that uses a changed type, then wait for
my approval. Do not add fields or values that are not listed here or in CLAUDE.md; if something
seems missing, ask me.

Decisions to apply:

Conventions
1. Add a shared `common.schema.json` with `Lang` ("en"|"hi"|"te"), `Money` ({amount ≥ 0, currency
   matching ^[A-Z]{3}$}), `AsrMeta`, and `SchemaVersion` (const "1.0"). Use them everywhere.
2. Every top-level wire object gets a required `schema_version`. Keep `additionalProperties: false`
   on every object. Every `lang` field uses `Lang`.
3. Data fields are required-but-nullable, not optional: make ProductJSON `rating`, `variants`,
   `delivery`, `seller` required with `null` allowed. Optional fields remain only for request
   options (e.g. TTSRequest.voice).
4. Constraints: all scores and confidences 0–1; Prefs.tts_rate 0.5–2.0; text_scale 1.0–3.0;
   ResolvedMode.scan_interval_ms 500–5000 and max_options 1–10; quantities and counts are
   integers ≥ 0 (quantity ≥ 1); all timestamps `format: date-time`, order dates `format: date`;
   OCRRequest requires exactly one of image_url / image_base64 (oneOf).

ProductJSON
5. `id` pattern `^[a-z0-9.-]+:.+$` (site:native_id). `missing` items are dot paths.
6. `availability` becomes {status: in_stock|low_stock|out_of_stock|preorder|unknown, text: string|null} | null.
7. `rating` becomes {value: 0–5 normalised, count: integer}.
8. `specs` keys must match ^[a-z0-9_]+$; SpecValue becomes {label: string, value: string|number|boolean, unit: string|null}.
9. `delivery.cost` becomes Money | null. `price` keeps {amount, currency, mrp: number|null}; document
   that mrp uses the same currency.
10. ProductImage adds `ocr_text: string|null`. ProductJSON adds `sponsored: boolean|null`.
11. ProductJSON adds required-nullable `reviews`: {basis_count: integer, summary_text: string|null,
    insights: [{topic, sentiment: positive|negative|mixed, mentions: {total, positive, negative}}],
    histogram: {"1","2","3","4","5": integer} | null, items: [{rating: number|null, title: string|null,
    text: string, date: date|null, verified: boolean|null}]}.

Page, targets, orders
12. PageType adds `orders` and `order_detail`. PageContext adds required `orders: OrderJSON[]` and
    `secure_zone_active: boolean`.
13. ActionTarget adds required `zone` (search|results|product|cart|checkout|orders|help), and
    nullable `state` {disabled, selected, expanded: boolean} and `colour_name: string|null`.
14. OrderItem.price becomes Money | null.

Turns and actions
15. TurnInput: `text` becomes string|null (the user's own language; the backend translates inside
    /turn), add `target_id: string|null` and `phrase_id: string|null`, `asr_meta` becomes AsrMeta|null.
    ASRResponse.asr_meta becomes AsrMeta. HistoryTurn.text is English (say so in its description).
16. TurnResponse: replace `intent`, `confidence`, `alternatives` with
    `intent: {name: string, confidence: 0–1, alternatives: max 2 [{label: string, intent: string,
    actions: ClientAction[]}]}`. Add required-nullable `workflow: {name: place_order|track_order|
    return_order|cancel_order, step: integer ≥ 1, total_steps: integer ≥ 1}`. Make `confirmation`
    required-nullable. Document that workflow state is kept by the backend per session_id.
17. ClientAction adds required `id` and required `expected_effect: {kind: cart_count_increase|
    url_change|element_appears|element_disappears|value_set|none, detail: string|null}`;
    `value` becomes required-nullable.
18. Confirmation: replace `action_ref` with `id` and `pending_actions: ClientAction[]` (run only
    after the user confirms; never also in TurnResponse.actions). Add required-nullable
    `read_back: {quantity: integer|null, total: Money|null, pin_code: string|null}`.

Outputs
19. Section.items become [{text: string, kind: text|pro|con|spec|row|warning, grounding_index:
    integer|null}]. Section adds required-nullable `table: {columns: string[], rows: string[][],
    spoken: string}` and `simpler: string|null`.
20. Grounding adds `subject_id` (a ProductJSON or OrderJSON id); field_path is a dot path into that
    subject (e.g. specs.battery.value, reviews.items[3].text).
21. ProductPrepareRequest drops `review_texts` (reviews travel inside ProductJSON).
    ReviewsSummarizeRequest becomes {schema_version, product} and drops review_texts and lang.
    Document on PreparedSections that sections are English and translated lazily.
22. ErrorResponse.code becomes an enum: rate_limited|auth_expired|upstream_unavailable|validation|
    not_found|secure_zone|internal.

Profile
23. Prefs adds `text_first: boolean`, `switch_key: string`, `preferred_payment: upi|saved_card|cod|null`.

Then:
- Run `make types` and fix every compile error in existing stubs (extension and backend) caused by
  the changes. Keep stubs minimal; don't implement features.
- Update every fixture in fixtures/mocks/ to realistic values that validate: an Amazon.in product
  with specs, 2 variants, reviews with insights and 5 items; a search page with 3 products, one
  sponsored; an orders page with 2 orders; a TurnResponse with a confirmation and read_back; an
  AccessibleOutput with pros, cons and a comparison table. Prices in INR.
- Update the schemas README: remove "DRAFT", state "Frozen at 1.0" and the change rules
  (additive optional field → small schema/<change> PR + announce, minor version bump; breaking
  change → all affected tracks agree, major version bump).
- Run `make check` until it passes.
- Finish with a table: schema, field, old → new, and which tracks are affected. Don't commit;
  I'll review and commit.
