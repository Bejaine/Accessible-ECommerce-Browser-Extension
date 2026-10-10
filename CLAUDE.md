# CLAUDE.md — Accessible Shopping Layer (Megathon 2026, Bhashini track)

A browser extension (Chrome desktop + Firefox for Android) plus a FastAPI backend that makes
real e-commerce sites (Amazon.in, Flipkart, generic product pages) usable for people with
visual, speech, hand-motor and age-related impairments, in English + Indian languages via Bhashini.

Several teammates work in parallel, each with their own Claude Code session, each on one
track. Integration only works if everyone follows the contracts below. Read this file fully
before writing code.

Your personal, gitignored `CLAUDE.local.md` says which track you are on and imports that
track's brief from `docs/tracks/`. If it is missing, ask which track before editing anything.
Formatting is applied automatically after every edit by `.claude/hooks/format.sh`; don't
hand-format or restyle code you didn't change.

Detailed specs (loaded into every session):
- Conditions, dysarthria handling, inference and multiple disabilities: @docs/conditions.md
- Payment safety, privacy, auth and demo rules: @docs/safety.md
- Product data, extraction, summaries, comparison and workflows: @docs/product.md

## Non-negotiable product rules

1. **No invented product facts.** Every price, spec, rating or review claim shown or spoken
   must come from a `ProductJSON` field or from fetched review text. If a field is missing,
   say "the page doesn't list this". Every claim in `AccessibleOutput` carries a `grounding` entry.
2. **Never complete payment automatically.** Checkout stops at a spoken + visual order summary.
   The extension may click "Place order" only after the user explicitly confirms that summary
   through our confirmation step (spoken "yes", one switch press, or the large confirm button).
   The LLM can never trigger it, and payment credentials (card, CVV, OTP, UPI PIN) are always
   entered by the user inside a secure zone where the mic is muted and nothing is extracted.
3. **Every consequential action needs confirmation** (add to cart, quantity change, address,
   place order, cancel/return). Return a `Confirmation` object; the client asks, the user answers.
4. **All user-facing text goes through `AccessibleOutput`.** No component may speak or render
   raw LLM prose. Renderers in `extension/src/render/` turn it into speech, large text, etc.
5. **Condition modes are suggested, never silently applied.** Inference proposes (only with at
   least two independent signals); the user accepts, cancels or lets a 10-second announced
   countdown finish. Always undoable. Colour vision is never inferred, only chosen by the user.
6. **Bhashini/AnuvaadHub models are called only from `backend/app/services/bhashini.py`.** No
   other module, and never the extension, talks to them or holds tokens. Each model's URL and
   token come from the gitignored registry `backend/config/models.local.json`; a per-model
   limiter enforces the approved RPM. Access flow and integration: @docs/language-api.md
7. **Don't translate brand names, model names, units or prices.** Mask them before NMT and
   restore after (see `backend/app/services/masking.py`).
8. **Profile and inferred conditions stay on the device** (`browser.storage.local`). The backend
   receives only the active preferences needed for one turn, never raw interaction signals.
9. **SerpApi is read-only enrichment, called only from `backend/app/services/serpapi.py`.**
   One `amazon_product` call per ASIN, cached; every summary task reads from that cached result.
   Never call SerpApi per feature, per language or from the extension. Prices, stock and delivery
   shown to the user come from the live page (what they will actually pay); SerpApi supplies
   specs, review insights, images and "compare with similar". All actions (cart, checkout,
   orders, returns) happen in the user's tab, never via SerpApi. Develop against recorded
   responses in `fixtures/serpapi/` (`MOCK=1`) to save quota.
10. **Precompute in parallel, speak one thing at a time.** Section summaries (specs, reviews,
   images, comparison) are generated concurrently when a product opens and cached as
   `AccessibleOutput`; translation and TTS run only for the section the user asks for.
11. **Never hide or restyle the shop's own content to "simplify" it.** Simplified and large-target
   layouts are our own overlay views built from ProductJSON and the page map.
12. **Every audio output plays through `extension/src/audio/player.ts`** as a sentence queue with
   cached audio, controllable by voice and by a single key (pause, resume, repeat sentence/all,
   back, next/previous section, slower, faster, stop). Replays never call TTS or the LLM again.

## Repo layout and ownership

```
shared/schemas/        JSON Schemas — the single source of truth for all contracts (owner: everyone, via PR)
shared/generated/      Generated TS + Pydantic types. NEVER hand-edit. Run `make types`.
extension/             WXT WebExtension (TypeScript)
  src/extract/         Track B — JSON-LD parser, site adapters, LLM-fallback request builder
  src/actuate/         Track B — performs ClientActions on the page
  src/audio/           Track A — mic capture, VAD, Opus encoding, local TTS fallback, player.ts
  src/ui/              Track D — injected overlay (shadow DOM), phrase chips, action menu, switch scanner,
                       simplified view, onboarding
  src/i18n/            Track A — build-time translated UI strings per language
  src/render/          Track D — AccessibleOutput renderers per mode
  src/infer/           Track D — signal collectors + condition scoring + suggestion flow
  src/match/           Track D — local command matcher + personal enrollment templates
  src/core/            Integration lead — message bus, session state, profile store
backend/
  app/services/        Track A — bhashini.py (AnuvaadHub gateway + rate limiter), masking.py, numbers.py, cache.py
  config/              Track A — models.example.json (committed), models.local.json (gitignored, tokens)
                       Track C — serpapi.py (Amazon product/search, ASIN-keyed cache)
  app/brain/           Track C — orchestrator, intent, tools, recommender, review summariser, vision
  app/routes/          Track C — FastAPI routes (thin; logic lives in services/brain)
  tests/
mock-store/            Track B — static product/search/cart/checkout pages for demo + tests
fixtures/              Saved HTML of real pages, recorded SerpApi JSON (fixtures/serpapi/), sample audio
eval/                  TORGO / command-recognition evaluation, accessibility audit scripts
docs/                  architecture.md, decisions.md (short ADRs), STATUS.md
```

Only edit files inside your track's directories. If you need something from another track,
use its mock (below) and note the request in `docs/STATUS.md`. Changes to `shared/schemas/`
go in their own small PR and must be announced to the team before merging.

## Contracts (summary — the JSON Schemas in shared/schemas/ win if this ever disagrees)

- `ProductJSON` — id, url, site, title, brand, price {amount, currency, mrp?}, rating? {value, count},
  availability, category, specs {key: {value, unit?}}, variants?, images [{url, alt?, description?}],
  delivery? {text, cost?, date?}, seller?, source {method: jsonld|adapter|llm|serpapi, extracted_at} (per-field source when merged),
  missing [field names]. Unknown values are `null` and listed in `missing`, never guessed.
- `PageContext` — page_type (search|product|reviews|cart|checkout|other), url, site,
  products [ProductJSON], targets [ActionTarget {id, kind, label}]. Selectors stay client-side.
- `Profile` — conditions {visual|speech|motor|ageing|colour: {score 0–1, active bool, source: inferred|user}}
  (colour is always source=user),
  prefs {lang, tts_rate, text_scale, verbosity: short|normal, lite_mode bool}. Any combination of
  conditions can be active; `src/core/composer.ts` resolves them into one `ResolvedMode`
  {input_channels, input_rung, output_channels, tts_rate, scan_interval_ms, max_options, verbosity}.
- `OrderJSON` — id (placeholder), items, status, dates, available_actions (track|return|cancel).
- `TurnRequest` — session_id, input {kind: voice|text|phrase|switch, text, lang, asr_meta?},
  page PageContext, prefs, history (last 6 turns).
- `TurnResponse` — intent, actions [ClientAction {type: click|fill|select|navigate|scroll, target_id, value?}],
  output AccessibleOutput, confirmation? Confirmation {prompt, action_ref, risk: low|high}.
- `AccessibleOutput` — lang, summary (≤2 short sentences, spoken first), sections [{heading, items}],
  simpler? (plain-language version), followups [suggested next utterances], grounding [{claim, field_path}],
  warnings [string]. Content is structured, not prose; renderers decide presentation.

Backend endpoints: `POST /product/prepare` (fetch + parallel precompute), `POST /ocr`, `POST /speech/asr`, `POST /speech/tts`, `POST /translate`, `POST /turn`,
`POST /vision/describe`, `POST /reviews/summarize`, `GET /health`. Every endpoint validates
input and output against the generated Pydantic models.

## Working against other tracks before they're ready

- Every backend route has a mock mode: `MOCK=1` returns canned responses from `fixtures/mocks/`.
- The extension has `VITE_BACKEND=mock` which serves the same fixtures in-browser.
- When you add or change a response shape, update its fixture in the same PR.

## Conventions

- TypeScript strict mode; Prettier + ESLint. Python 3.11, FastAPI, Pydantic v2, ruff, pytest.
- Secrets only in `.env` (gitignored); document new variables in `.env.example`.
- Errors: backend returns `{error, code, retryable}`; the client turns them into a spoken,
  calm message plus a retry or alternative (never a silent failure, never a stack trace).
- Latency budget per voice turn: aim for under 4 s end to end. At most 2 LLM calls per turn.
  No agent frameworks; tools are plain functions called via the LLM's function calling.
- Lite mode (slow network): text replies only, shorter summaries, local TTS, cached phrases.
- Behaviour telemetry: passive, throttled listeners in the content script; no Web Workers (page
  CSPs and origin rules make them unreliable in content scripts, and the maths is cheap).
- UI strings are pre-translated at build time in `extension/src/i18n/`; never call Bhashini for them.

## Accessibility rules for any UI code (Track D reviews all UI PRs)

- Real headings and landmarks; every control has an accessible name; logical focus order.
- Announce changes through one ARIA live region managed by `src/ui/announce.ts`.
- Touch/click targets at least 44×44 px; never rely on colour alone; respect
  `prefers-reduced-motion` and `prefers-contrast`.
- No time limits on user input. Everything reachable by keyboard and by switch scanning.
- Test with NVDA or ChromeVox on desktop and TalkBack on Android before marking done.

## Workflow

- Branches: `track-a/...`, `track-b/...`, `track-c/...`, `track-d/...`. Small PRs into `main`.
- Before opening a PR run `make check` (types regenerate cleanly, lint, tests, schema validation
  of all fixtures). Don't merge red.
- Update `docs/STATUS.md` (what works, what's mocked, blockers) at the end of each work block.
- Record any design decision that affects another track in `docs/decisions.md` (3–5 lines).

## Commands

- `make types` — regenerate `shared/generated/` from `shared/schemas/`
- `make check` — lint + tests + fixture validation for everything
- `make backend` — run FastAPI locally (`MOCK=1 make backend` for mocks)
- `make ext` / `make ext-firefox` — dev builds of the extension for Chrome / Firefox Android
