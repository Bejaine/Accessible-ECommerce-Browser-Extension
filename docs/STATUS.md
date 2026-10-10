# Status (update at the end of every work block)

| Track | Working for real | Still mocked | Blockers |
|---|---|---|---|
| A Speech | AnuvaadHub gateway (registry, RPM limiter, error mapping, MT/TTS cache, startup warm-up); `/speech/asr`, `/speech/tts`, `/translate`, `/ocr` live for en/hi/te (+ ml/ur in the gateway); live smoke test `backend/tests/smoke_language_api.py`; extension mic capture + VAD + 16 kHz WAV (`src/audio/mic.ts`), verified against live Hindi ASR | Masking (identity stub), numbers, player, i18n hi/te, mic not yet wired into the overlay | Shared token expires 13 Oct 10:00 IST; mic not yet tried in a real browser / Firefox Android |
| B Page | | | |
| C Brain | | | |
| D Access UX | Scaffold: overlay shell + live region, bus, profile store, `make check` | Everything else | Schemas are DRAFT until team review |

## Requests for other tracks
- **A → integration lead (`src/core/`)**: wire voice turns as `createMic().listen({ mode })` →
  `toAsrRequest(utterance, lang)` → `backend.asr()` (background) → `TurnRequest.input` with
  `asr_meta` from the response. `mode` is `'speech'` when the speech condition is active
  (2.5 s silence timeout). One `Mic` per tab. Needs bus messages for listen/stop if the UI and
  the turn loop live in different modules.
- **A → Track B (`src/extract`)**: when a secure-zone field gains focus, call `mic.mute()`;
  when focus leaves, `mic.unmute()` (docs/safety.md). `mute()` closes the mic immediately and
  discards the audio; `listen()` then rejects with `MicError` code `secure_zone`.
- **A → Track D (`src/ui`)**: a mic button/key that calls `listen()`, a level meter from
  `onLevel` (0–1, ~10/s), and the `MicError` codes spoken via `t('mic.<code>')` (strings in
  `src/i18n/en.json`). `listen()` must be called from a user gesture (key press or tap).
- **A → Track C (`/turn`)**: `asr_meta.confidence` is always null and `alternatives` empty
  (AnuvaadHub ASR returns text only); use `mic_level` to tell silence (≈0) from unclear speech.
