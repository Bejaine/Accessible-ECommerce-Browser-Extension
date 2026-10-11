// Calibration recorder (dev builds): __asl.recordSession → signals → __asl.saveSession downloads a
// session file that the `make eval-inference` replay reads. Recordings themselves come later from
// teammates; this checks the tooling works end to end.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { installDevHooks } from '../src/core/devtools';
import { createProfileStore } from '../src/core/profile';
import { replaySession, type RecordedSession } from '../src/infer/replay';
import { recordingSpeaker } from './helpers/fakeSpeaker';

describe('calibration recorder', () => {
  let app: App;
  let host: HTMLElement;
  let saved: string | null;

  beforeEach(async () => {
    fakeBrowser.reset();
    saved = null;
    host = document.createElement('div');
    document.body.append(host);
    const store = await createProfileStore();
    const bus = createBus();
    app = mountApp(host, store, bus, createMockBackend(), { speaker: recordingSpeaker().speaker });
    installDevHooks(bus, () => app, store);
    // Capture the download instead of saving a file.
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      void (blob as Blob).text().then((text) => (saved = text));
      return 'blob:session';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.restoreAllMocks();
  });

  it('records signals between start and save, and the file replays', async () => {
    const asl = (globalThis as unknown as { __asl: Record<string, (...a: unknown[]) => unknown> })
      .__asl;
    expect(asl.saveSession!()).toMatch(/not recording/);
    app.engine.add('large_text'); // before recording: not included
    expect(asl.recordSession!('motor')).toMatch(/recording "motor"/);
    app.engine.add('repeat_click');
    app.engine.add('low_path_efficiency');
    expect(asl.saveSession!('SS')).toMatch(/saved 2 signals/);
    await vi.waitFor(() => expect(saved).not.toBeNull());

    const session = JSON.parse(saved!) as RecordedSession;
    expect(session).toMatchObject({ label: 'motor', recordedBy: 'SS' });
    expect(session.signals.map((s) => s.kind)).toEqual(['repeat_click', 'low_path_efficiency']);
    // Only signal names and timings: nothing about the page or what was typed.
    expect(Object.keys(session.signals[0]!).sort()).toEqual(['at', 'kind']);
    const result = replaySession(session);
    expect(result.label).toBe('motor');
    expect(result.peak.motor).toBeGreaterThan(0);
  });
});
