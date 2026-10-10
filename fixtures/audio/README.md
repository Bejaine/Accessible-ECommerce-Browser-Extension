# Sample audio (Track A)

Real voices for the ASR round trip: a team member reading short shopping commands in English,
Hindi and Telugu (recorded with consent). 16 kHz mono 16-bit WAV, the format the extension sends.
`expected.json` holds what each clip says (and the number, for budget clips).

- `make check` (`backend/tests/test_audio_fixtures.py`): clips are valid and `/speech/asr` accepts them.
- Live (`backend/tests/roundtrip_audio.py`, `MOCK=0`): word error rate of the real ASR per clip.

Results 2026-10-11: mean WER en 8%, hi 0%, te 19% (Telugu errors were spellings of English
loanwords: "కాట్లో" for cart, "ఫోన్స్" for ఫోన్లు); every spoken budget came out as 20000;
0.5–0.7 s per clip. Record only your own voice, with consent.
