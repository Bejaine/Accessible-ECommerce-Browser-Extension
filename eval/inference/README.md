# Inference calibration (Track D)

Goal (docs/conditions.md): normal use must trigger **no** suggestions; simulated conditions should
get the right one. The evaluation slide reports the false-suggestion rate on normal sessions.

## Record a session (dev build, `make ext`)

1. Open a shop page, open DevTools → Console → context **Accessible Shopping Layer**.
2. `__asl.recordSession('normal')` (or `'visual'`, `'motor'`, `'speech'`, `'ageing'` while
   simulating that condition, e.g. keyboard and screen reader only, a shaky mouse, …).
3. Shop normally for 3–5 minutes.
4. `__asl.saveSession('your-initials')` downloads `session-<label>-<time>.json`.
5. Move the file into `eval/inference/sessions/`.

Recordings contain only signal names and timings (no page content, no keystrokes, no URLs).

## Run

```
make eval-inference      # writes eval/inference/report.md
```

Tune weights in `extension/src/infer/scores.ts` (and thresholds in `collectors.ts` → `TUNING`)
until normal sessions show 0 suggestions, then re-run.
