# Track A — Speech and language

Owns: `backend/app/services/{bhashini,masking,numbers,cache}.py`, `extension/src/audio/`.

Deliver, in order:
0. Hour 0: start the AnuvaadHub sign-up and model requests (docs/language-api.md) — approval is the
   longest wait in the project.
1. Hour 2: gateway + registry + limiter against mock fixtures; as soon as tokens arrive, one real
   round trip (ASR → MT → TTS) for English, Hindi, Telugu from a script, using the spec PDF formats.
2. Hour 8: `/speech/asr`, `/translate`, `/speech/tts` routes with MOCK mode; mic capture + VAD +
   Opus upload in the extension (test Firefox Android mic permission first).
3. Hour 12: masking of brands/models/units/prices around NMT; number normaliser for spoken input
   (native digits, number words, lakh/crore, "dedh/dhai") with a table-driven test file.
4. Hour 20: TTS number formatting per language, phrase cache, lite mode (device TTS fallback).

Done means: tests in `backend/tests/test_numbers.py` and `test_masking.py` pass, and fixtures in
`fixtures/audio/` round-trip in all three languages.


Also yours: speech-mode silence timeout (2.5 s vs 1.0 s default) and passing ASR metadata
in `asr_meta`; muting the mic in secure zones (see docs/safety.md).
Also yours: build-time UI string translations in `extension/src/i18n/`, mic level reporting
(so silence vs unclear speech can be told apart), and sentence-by-sentence streaming
NMT → TTS playback for free-form answers.
Also yours: `src/audio/player.ts` (sentence queue, cached audio, playbackRate, echo-cancelled
barge-in) and the OCR route for text in product images.
