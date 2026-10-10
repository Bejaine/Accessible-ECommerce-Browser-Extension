// Inference calibration report: replays every recorded session in ./sessions through the real
// score engine and writes ./report.md (false-suggestion rate on normal use, detection per
// simulated condition). Run: `make eval-inference`. Uses only real recordings; with none, the
// report says so.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'vitest';
import { replaySession, summarise, type RecordedSession } from '../../extension/src/infer/replay';
import { INFERRED_CONDITIONS } from '../../extension/src/infer/scores';

const dir = join(__dirname, 'sessions');

it('writes the inference calibration report', () => {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const sessions = files.map((f) => ({
    file: f,
    ...(JSON.parse(readFileSync(join(dir, f), 'utf8')) as RecordedSession),
  }));
  const results = sessions.map((s) => ({ file: s.file, ...replaySession(s) }));
  const summary = summarise(results);
  const pct = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);

  const lines = [
    '# Inference calibration report',
    '',
    `Generated ${new Date().toISOString()} from ${sessions.length} recorded session(s) in eval/inference/sessions/.`,
    '',
  ];
  if (sessions.length === 0) {
    lines.push(
      'No sessions recorded yet. Record some (see README.md) and run `make eval-inference` again.',
    );
  } else {
    lines.push(
      `**False-suggestion rate on normal use:** ${pct(summary.falseSuggestionRate)} ` +
        `(${summary.falseSuggestions} of ${summary.normalSessions} normal sessions).`,
      '',
      '| Simulated condition | Sessions | Correct suggestion |',
      '|---|---|---|',
      ...INFERRED_CONDITIONS.map(
        (c) => `| ${c} | ${summary.detection[c].sessions} | ${summary.detection[c].correct} |`,
      ),
      '',
      '| Session | Label | Suggested | After (s) | Peak scores (visual / speech / motor / ageing) |',
      '|---|---|---|---|---|',
      ...results.map(
        (r) =>
          `| ${r.file} | ${r.label} | ${r.suggested ?? '-'} | ${r.at === null ? '-' : (r.at / 1000).toFixed(0)} | ` +
          INFERRED_CONDITIONS.map((c) => r.peak[c].toFixed(2)).join(' / ') +
          ' |',
      ),
    );
  }
  writeFileSync(join(__dirname, 'report.md'), lines.join('\n') + '\n');
  console.info(lines.join('\n'));
});
