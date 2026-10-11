// The background script relays every backend call. Firefox for Android has no commands API;
// the relay must still come up there (Track A found it dying on a real phone).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import background from '../entrypoints/background';

type Relay = (msg: unknown) => Promise<unknown> | undefined;

/** Runs the background script and returns the runtime.onMessage listener it registered. */
function start(): Relay {
  const add = vi.spyOn(fakeBrowser.runtime.onMessage, 'addListener');
  background.main();
  const relay = add.mock.calls[0]?.[0] as Relay | undefined;
  if (!relay) throw new Error('no runtime.onMessage listener');
  return relay;
}

describe('background script', () => {
  const commands = fakeBrowser.commands;
  afterEach(() => {
    (fakeBrowser as { commands?: unknown }).commands = commands;
    vi.restoreAllMocks();
    fakeBrowser.reset();
  });

  it('relays backend calls even without a commands API (Firefox for Android)', async () => {
    (fakeBrowser as { commands?: unknown }).commands = undefined;
    const relay = start();
    expect(await relay({ type: 'backend', method: 'health' })).toMatchObject({ ok: true });
  });

  it('registers the shortcut where the commands API exists, and shapes unknown calls', async () => {
    const onCommand = vi.fn();
    (fakeBrowser as { commands?: unknown }).commands = { onCommand: { addListener: onCommand } };
    const relay = start();
    expect(onCommand).toHaveBeenCalledOnce();
    expect(await relay({ type: 'backend', method: 'nope' })).toEqual({
      ok: false,
      error: { error: 'Unknown request.', code: 'validation', retryable: false },
    });
  });
});
