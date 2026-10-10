# Persona runs (Track D)

`make e2e` runs each required combination from docs/conditions.md end to end on MockMart:
real store pages (Track B's store.js), Track B's extractor and actuator, Track D's app driven only
through that persona's input method, and Track C's real backend started with `MOCK=1` (taps and
phrase chips need no LLM). Voice output is recorded rather than played. Results go to
`report.md`; nothing is invented: a step that cannot complete is reported as blocked or failed.

Not covered here: real ASR/TTS/LLM latency (needs tokens), screen readers, real shop sites.
