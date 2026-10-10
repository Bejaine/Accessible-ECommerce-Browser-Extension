# Language API fixtures (Track A)

Raw AnuvaadHub responses, in the envelope from ANUVAADHUB_API_SPECIFICATIONS.pdf:
`{status, message, data, error, code}`. Mock mode looks for `<task>.<key>.json`,
e.g. `asr.hi.json`, `mt.en-hi.json`, `tts.te.json`, `ocr.en.json`.

| Task | `data` field     | Notes                                                   |
| ---- | ---------------- | ------------------------------------------------------- |
| MT   | `output_text`    |                                                         |
| ASR  | `recognized_text`|                                                         |
| TTS  | `s3_url`         | the spec's example URL; never fetched in mock mode      |
| OCR  | `decoded_text`   | message is "OCR Inference performed successfully"       |

Binary stand-ins served instead of downloads in mock mode:
`tts.audio.wav` (0.1 s of silent 16 kHz mono WAV) and `ocr.image.png` (1×1 white PNG).

The texts are our own samples; the shapes are verbatim from the spec. Replace a file with a
real response captured from "Try Model" when you have one.

MT fixtures carry `_mock_input` (not part of the API): in mock mode they translate only that
exact text; any other text fails as `upstream_unavailable`, so callers keep English instead of
showing a canned sentence as a translation.
