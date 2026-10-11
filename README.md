# Accessible Shopping Layer

Setup and run instructions. Licensed under MIT (see `LICENSE`).

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node.js | 20+ (CI uses 22) | extension, linting, type generation |
| Python | 3.11 (exactly) | backend |
| [uv](https://docs.astral.sh/uv/) | any (optional) | faster Python installs; `make setup` falls back to pip |
| GNU Make | any | the commands below |
| Chrome and/or Firefox | system install | `make ext` / `make ext-firefox` open them with the extension loaded |

## Setup

```
make setup     # npm install (root + extension) and .venv with the backend's dependencies
make types     # generate shared/generated/ from shared/schemas/
make check     # lint, type checks, all tests, fixture validation
```

If `python3.11` isn't your interpreter's name: `make setup PY=/path/to/python3.11`.

### API keys (only for live models; everything also runs without them, on recorded responses)

1. `cp .env.example .env` and fill in `GROQ_API_KEY` (or `GROQ_API_KEYS`), `GEMINI_API_KEY` and,
   optionally, `SERPAPI_API_KEY`. Set `MOCK=0`.
2. `cp backend/config/models.example.json backend/config/models.local.json` and fill in the
   Bhashini (AnuvaadHub) model URLs and access tokens for ASR, MT, TTS and OCR.

Both files are gitignored. Never commit keys.

## Run

1. **Backend**
   - Recorded responses, no keys needed: `make backend`
   - Live models: `MOCK=0 make backend` (wait ~25 s for the language models to warm up)
   - Check: `curl localhost:8000/health`; API docs at http://localhost:8000/docs
2. **Demo store (MockMart)**: `python3 -m http.server 8080 -d mock-store`, then open
   http://localhost:8080/?reset=1
3. **Extension**
   - Chrome, against the backend: `VITE_BACKEND=http://localhost:8000 make ext`
   - Firefox: `VITE_BACKEND=http://localhost:8000 make ext-firefox`
   - Without a backend (in-browser sample data, no speech recognition): `make ext`
   - To load it by hand instead: `make build`, then load `extension/.output/chrome-mv3`
     (chrome://extensions → Developer mode → Load unpacked) or `extension/.output/firefox-mv3`
     (about:debugging → Load Temporary Add-on).
   - On a shop page or MockMart, open the assistant with **Alt+Shift+A** or the "Shopping
     assistant" button; hold **Space** to talk.
4. **Firefox for Android**: `BACKEND_HOST=0.0.0.0 make backend`, build with
   `VITE_BACKEND=http://<laptop LAN IP>:8000 make build`, then follow `extension/README.md`.

## Tests and reports

```
make test              # extension + backend tests (make test-ext / make test-backend)
make e2e               # persona runs on MockMart against the backend -> eval/e2e/report.md
make a11y              # accessibility audit in headless Chrome -> eval/a11y/report.md
make eval-inference    # inference calibration report (needs recorded sessions, eval/inference/)
```

## Datasets and model weights

None to download. All models are used through hosted APIs (Bhashini via AnuvaadHub, Groq,
Gemini); tests replay recorded responses from `fixtures/`. Libraries, APIs and data used are
listed in `docs/dependencies.md`.
