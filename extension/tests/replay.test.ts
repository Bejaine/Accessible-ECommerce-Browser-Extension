import { describe, expect, it } from 'vitest';
import { replaySession, summarise, type RecordedSession } from '../src/infer/replay';

// Small hand-made inputs to test the replay mechanics only (not calibration data).
const session = (
  label: RecordedSession['label'],
  signals: RecordedSession['signals'],
  durationMs = 120_000,
): RecordedSession => ({
  label,
  durationMs,
  signals,
});

describe('session replay', () => {
  it('reports the first condition that became ready, and when', () => {
    const signals = Array.from({ length: 10 }, (_, i) => [
      { kind: 'repeat_click' as const, at: 10_000 + i * 1000 },
      { kind: 'near_miss' as const, at: 10_500 + i * 1000 },
    ]).flat();
    const r = replaySession(session('motor', signals));
    expect(r.suggested).toBe('motor');
    expect(r.at).toBeGreaterThan(10_000);
    expect(r.peak.motor).toBeGreaterThanOrEqual(0.7);
  });

  it('a single kind of evidence never triggers a suggestion', () => {
    const signals = Array.from({ length: 50 }, (_, i) => ({
      kind: 'click_without_pointer' as const,
      at: i * 2000,
    }));
    expect(replaySession(session('normal', signals)).suggested).toBeNull();
  });

  it('summarises the false-suggestion rate and detection', () => {
    const results = [
      {
        label: 'normal' as const,
        suggested: null,
        at: null,
        peak: { visual: 0, speech: 0, motor: 0, ageing: 0 },
      },
      {
        label: 'normal' as const,
        suggested: 'motor' as const,
        at: 5000,
        peak: { visual: 0, speech: 0, motor: 0.8, ageing: 0 },
      },
      {
        label: 'motor' as const,
        suggested: 'motor' as const,
        at: 5000,
        peak: { visual: 0, speech: 0, motor: 0.8, ageing: 0 },
      },
    ];
    const s = summarise(results);
    expect(s.falseSuggestionRate).toBe(0.5);
    expect(s.detection.motor).toEqual({ sessions: 1, correct: 1 });
    expect(summarise([]).falseSuggestionRate).toBeNull();
  });
});
