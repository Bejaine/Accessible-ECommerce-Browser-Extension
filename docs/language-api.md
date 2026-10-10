# Language APIs via AnuvaadHub (Track A owns)

Bhashini-family models (MT, ASR, TTS, OCR) are accessed through AnuvaadHub. Access has two
admin approval gates, so start it before anything else.

## Access checklist (do today, in this order)

1. One teammate signs up for the team account and waits for the approval email.
   Ask the organisers whether each member should also have an account.
2. Log in → Model Dashboard. For every model below, press Request API with:
   - Start date: today. End date: at least a week after the final demo, so judges can rerun.
   - RPM: ASR 30, MT 60, TTS 60, OCR 10 (see estimate below). Ask for what we need, not more.
3. Models to request (one per task per language, or multilingual ones if offered):
   - ASR: English, Hindi, Telugu (+ any bonus languages)
   - MT: en↔hi, en↔te (+ bonus pairs)
   - TTS: English, Hindi, Telugu (+ bonus)
   - OCR: Indic + English (text on product images, image-based size charts)
4. When a card is approved, copy its API URL and access token into
   `backend/config/models.local.json` (gitignored). Never into the repo, chat or the extension.
5. Download "View API Specification" (PDF). Save it to `docs/vendor/` only if its terms allow;
   otherwise keep it in the team drive. Copy each example request/response into
   `fixtures/language-api/` and write the adapter against those, not against guesses.
6. Use "Try Model" on each card to check quality before integrating: code-mixed Hinglish,
   numbers and prices, brand names, slow or unclear speech. Pick the best model per language
   where several institutes offer one; record the choice in docs/decisions.md.
7. Watch the Usage Dashboard during development and before the demo.

## RPM estimate

One voice turn ≈ 1 ASR + 2 MT + 1–3 TTS (sentence streaming). Peak demo ≈ 6 turns/min;
four developers testing in parallel ≈ 4× that, but development runs on mocks by default.
So ~20–30 RPM per ASR model and ~40–60 per MT/TTS model leaves headroom.

## How the code uses it

- `backend/app/services/bhashini.py` is the single gateway (rule 6). It wraps an AnuvaadHub
  provider; every model is looked up in a registry loaded from `backend/config/models.local.json`:
  `{ "asr": {"hi": {"url": "...", "token": "...", "model": "..."}}, "mt": {"en-hi": {...}}, ... }`.
  `models.example.json` (committed) shows the shape with empty values.
- A token-bucket limiter per model enforces the approved RPM so the team never exceeds it.
- Errors: 401/403 (token expired or end date passed) and 429 (rate limit) map to
  `{error, code, retryable}`; the client speaks a calm message and offers text input or a retry.
  On any language-API failure in the demo, fall back to the cached phrase audio and device TTS.
- `MOCK=1` (default in development) serves `fixtures/language-api/`; only the demo machine and
  integration tests use real tokens.
- No language-identification model is listed, and ASR models are per language, so the active
  language comes from onboarding and the "switch language" command. If an utterance fails in the
  chosen language, offer to switch rather than running several ASR models in parallel.
- If TTS has no speed parameter, speed is changed on the client with the audio element's
  playbackRate (pitch preserved), which also means changing speed never needs a new TTS call.
- OCR: text on product images and image-based size charts goes to OCR first; the VLM only
  describes what OCR can't (shape, colour, contents). OCR text is also used to ground VLM claims.
