# Backend API guide (Track C) — for whoever wires the extension

How the extension should call the backend and handle what comes back. The contracts are the
JSON Schemas in `shared/schemas/`; this file explains the behaviour behind them. Questions →
Track C.

## 1. Running it

| Mode | Command | What answers |
|---|---|---|
| Mock | `MOCK=1 make backend` | Real Track C code; Groq/Gemini/SerpApi/Bhashini replayed from `fixtures/` (see §7) |
| Real | `MOCK=0 make backend` with `.env` (GROQ_API_KEY, GEMINI_API_KEY) and Track A's `backend/config/models.local.json` | Live models |

- Port 8000. `GET /health` → `{status: "ok", mock: true|false}`.
- Real mode warms the language models at startup (~25 s, Track A): start the backend a minute
  before a demo. First Groq call per product takes 2–7 s; later calls are cached.
- Interactive docs (every request/response shape): http://localhost:8000/docs

## 2. Calling it from the extension

`extension/src/core/backend.ts` already has a client (`createBackend()`): `VITE_BACKEND=mock`
serves `fixtures/mocks/` in the browser, `VITE_BACKEND=http://localhost:8000` calls the backend.

- Call it from the **background script** (as the client says), not the content script: the
  backend has no CORS setup, and `host_permissions` already allows `http://localhost:8000/*`.
- **Firefox for Android:** the phone can't reach the laptop's `localhost`. Use the laptop's LAN
  address (`VITE_BACKEND=http://192.168.x.y:8000`, add it to `host_permissions`, run uvicorn
  with `--host 0.0.0.0`).
- `extractFallback` is in the client (Track B's tier 3 runs through `completeWithFallback`).
- `session_id` comes from the background script (`src/core/continuity.ts`): one id for every page
  and site until 30 idle minutes, so tasks survive page loads.

## 3. Endpoints and when to call them

| When | Call | Notes |
|---|---|---|
| Extension start | `GET /health` | |
| Product page loaded (after `extractPageContext`) | `POST /product/prepare` {product, prefs} | **Fire and forget**; don't wait (2–7 s first time). Speak title + price from the page meanwhile. It precomputes overview, specs, reviews, images (Gemini describes the main photo) and, on Amazon, a comparison, cached per product. Sections are English. |
| JSON-LD + adapter left key fields missing | `POST /extract/fallback` {url, site, missing, text, truncated} | Built by `buildLlmFallbackRequest`. Never returns a price (by design). |
| **Anything the user says, types, taps or picks** | `POST /turn` | The main endpoint (§4). Translates into and out of the user's language. |
| Speech in/out, translation, OCR | `/speech/asr`, `/speech/tts`, `/translate`, `/ocr` | Track A's routes. |
| A single image description outside a product | `POST /vision/describe` | Mostly used inside `/turn` ("describe the photo"). |

## 4. `POST /turn`

### Request
- `session_id`: **keep the same id for the whole shopping session, across pages and sites.**
  The backend remembers per session (30 min idle): products the user opened (for "compare with
  the one I saw earlier"), stated preferences ("camera matters, budget 20000"), order tasks in
  progress and failed attempts. Nothing about the user is stored beyond that session.
- `page`: the **current** `PageContext` (fresh each turn). Set `secure_zone_active` when focus is
  in a payment/password/OTP field: the backend then answers 423 `secure_zone` and does nothing.
- `input`:

| User did | `kind` | Fill |
|---|---|---|
| Spoke | `voice` | `text` (ASR text, user's language), `lang`, `asr_meta` (`confidence` may be null; `mic_level` 0–1) |
| Typed | `text` | `text`, `lang` |
| Picked a phrase chip / follow-up | `phrase` | `text` = the chip's label exactly as we sent it in `output.followups` |
| Tapped / switch-selected a page control | `switch` | `target_id` (no LLM call) |

- `history`: up to 6 recent turns in English, or `[]`. The backend doesn't depend on it.
- These chip labels run without an LLM call (fast, deterministic): Price, Specs, Reviews,
  Describe the photos, Describe the next photo, Add to cart, Read the results, Cheapest,
  Best rated, Where am I?, Read my cart, Track my order, Cancel an order, Return an order,
  Place my order, **Continue**, **Stop**.

### Response — handle in this order
1. **`output`** (`AccessibleOutput`): speak `summary` first, then `sections` on request; show
   `followups` as chips; read `warnings` (e.g. "made by AI", listing errors, sponsored left out).
   Use **`output.lang`** for TTS: it can be `en` even when the user speaks Hindi (translation
   failed and we refuse to send a half-translated answer).
2. **`actions`**: safe to run now (choose a colour, open a result, search, open the cart).
   Run them with the actuator, check `expected_effect`, and tell the user if it didn't happen.
3. **`confirmation`** (when not null): consequential. Speak `prompt`, show `read_back` numbers
   large (quantity, total, PIN code), and wait for yes/no (voice, any key, tap or switch).
   - **Yes** → run `pending_actions` in order, verify their effects.
   - **No** → run nothing; say "OK, I didn't do it".
   - `risk: "high"` = cancel, return, place order, final submit buttons. **Never run
     `pending_actions` without the user's explicit yes.** They are never also in `actions`.
4. **`intent`**: `confidence` ≥ 0.8 → we acted or answered. 0.5–0.8 → we didn't act; `output`
   asks "Did you mean X or Y?" and `intent.alternatives` are the options. Picking one: run its
   `actions` if it has any, otherwise send its `label` as a `phrase` turn. Below 0.5 → chips.
5. **`workflow`** (when not null): an order task in progress — show "Step 2 of 3". After the
   user said yes and you ran `pending_actions`, **send a `phrase` turn "Continue"** once the new
   page is loaded: the backend reads that page to finish or verify the task.

### What the backend does with an utterance (for debugging)
spoken numbers → digits ("dedh lakh" → 150000) → redaction (cards, OTP/PIN, CVV, Aadhaar, PAN,
phone, email) → translation to English (Track A, brands kept) → ONE Groq tool call that picks a
tool → the tool builds the answer from the page data → grounding check (unsupported claims are
removed) → translation back (all lines in parallel) → response. At most 2 LLM calls per turn.

### Example (trimmed)
```json
// request: a Hindi voice turn on a product page
{"schema_version": "1.0", "session_id": "tab-42",
 "input": {"kind": "voice", "text": "isse cart mein daal do", "lang": "hi", "target_id": null,
           "phrase_id": null, "asr_meta": {"confidence": null, "mic_level": 0.55, "alternatives": []}},
 "page": {"...": "PageContext from extractPageContext"}, "prefs": {"...": "..."}, "history": []}
// response
{"intent": {"name": "add_to_cart", "confidence": 0.95, "alternatives": []},
 "actions": [],
 "confirmation": {"risk": "low", "prompt": "अपने कार्ट में Zentra Pulse 5G जोड़ें? मात्रा 1, कीमत ₹17,999।",
                  "pending_actions": [{"type": "click", "target_id": "t-add-to-cart",
                                       "expected_effect": {"kind": "cart_count_increase"}}],
                  "read_back": {"quantity": 1, "total": {"amount": 17999, "currency": "INR"}, "pin_code": null}},
 "workflow": null,
 "output": {"lang": "hi", "summary": "अपने कार्ट में Zentra Pulse 5G जोड़ें? ...", "followups": ["हाँ।", "नहीं।"]}}
```

## 5. Errors

Every error is `{error, code, retryable}`. Speak a calm message and offer a way on; never read
out `error` text verbatim to a user mid-task without context.

| HTTP | `code` | Meaning | Suggested handling |
|---|---|---|---|
| 400 / 422 | `validation` | Request didn't match the schema | Bug in the caller; log it, say "Something went wrong, please try again" |
| 404 | `not_found` | Missing recording/resource | Mostly mock mode |
| 423 | `secure_zone` | `page.secure_zone_active` was true | Expected: stay quiet, mic is off; resume when focus leaves |
| 429 | `rate_limited` | Model rate limit | `retryable: true` → retry after a moment, or offer chips |
| 503 | `upstream_unavailable` | Groq/Gemini/Bhashini down or not configured | `retryable: true` → "I couldn't do that right now", offer chips/typing |
| 401/403 → | `auth_expired` | Language-model token expired (Track A) | Tell the team; demo falls back to English |
| 500 / 501 | `internal` | Bug | Log; calm message |

Translation failures are **not** errors: the answer comes back in English with `lang: "en"`.

## 6. Order tasks (`workflow`)

| Task | Steps | Where |
|---|---|---|
| track_order | choose order → status | orders page (opens it if needed) |
| cancel_order | choose → confirm (high) → verify | orders page, then the cancel page |
| return_order | choose → reason → confirm (high) → verify | orders page, then the return page |
| place_order | summary + confirm (high, total + PIN read back) → verify | checkout page; needs `page.checkout` |

Several orders → "Which order do you want to …?" with the items as chips. "Stop" ends any task.
Place order is refused unless `page.checkout` has a total, a selected payment method and the
Place-order target id. Buttons are tied to orders by the number in the target id
(`t-cancel-1` ↔ `ORDER_1`).

## 7. Mock mode (`MOCK=1`)

- `/product/prepare`, `/reviews/summarize`: real code; LLM answers replayed for the fixture
  products (Zentra mock phone, iPhone 16 from SerpApi), templates otherwise.
- `/turn`: the real orchestrator with recorded Groq tool calls for these utterances (exact text);
  any other text returns the canned `fixtures/mocks/TurnResponse.json`:
  "what do the reviews say", "isse cart mein daal do", "add two of these to my cart",
  "does it have a big battery", "show me the green one", "buy it now",
  "search for wireless earphones under 2000", "a cart", "mmm hmm uh",
  "which one is the cheapest", "compare the first two" (search page),
  "tell me something about the warranty", "describe the main photo", "how much does it weigh",
  "compare this with the iPhone I saw earlier", "which phone is best for me under 16000",
  "I want the one with the best battery", "where is my earphones order",
  "I want to return the back cover", "it came broken", "actually never mind",
  "cancel my order", "place my order", "go ahead and order it".
  Phrase chips and taps always work (no LLM needed).
- Translation in mock only works for Track A's recorded samples, so answers stay English.

## 8. Limits to know for the demo

- Groq free tier ≈ 2 *new* products per minute for `/product/prepare` (then templates until it
  recovers); a /turn is ~1–2 s. Gemini describes one photo per product (cached).
- TTS is the slow part (Track A: 3–19 s per sentence): play sentence by sentence.
- Session memory is in the backend process: restarting it forgets sessions.
