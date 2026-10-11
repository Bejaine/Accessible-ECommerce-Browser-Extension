import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { mountApp, SUGGEST_CHECK_MS, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { createProfileStore, type ProfileStore } from '../src/core/profile';

describe('content-script app: inference -> suggestion -> mode -> undo', () => {
  let host: HTMLElement;
  let app: App;
  let store: ProfileStore;

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    store = await createProfileStore();
    app = mountApp(container, store, createBus(), createMockBackend());
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  });

  const shadow = () => host.shadowRoot!;
  const motorEvidence = () => {
    for (let i = 0; i < 10; i++) {
      app.engine.add('repeat_click');
      app.engine.add('near_miss');
    }
  };

  it('suggests, counts down, applies to the stored profile, rebuilds the mode, and undoes', async () => {
    motorEvidence();
    vi.advanceTimersByTime(SUGGEST_CHECK_MS);
    expect(app.suggester.state).toMatchObject({ kind: 'countdown', condition: 'motor' });
    expect(shadow().querySelector('.asl-toggle')?.textContent).toBe(
      'Shopping assistant (suggestion)',
    );
    expect(shadow().querySelector('.asl-suggestion h3')?.textContent).toBe('Easy-press mode');

    vi.advanceTimersByTime(10_000);
    await vi.waitFor(() => expect(store.get().conditions.motor.active).toBe(true));
    expect(store.get().conditions.motor.source).toBe('inferred');
    expect((await fakeBrowser.storage.local.get('profile')).profile).toBeTruthy();

    [...shadow().querySelectorAll<HTMLButtonElement>('.asl-suggestion button')]
      .find((b) => b.textContent === 'Undo')!
      .click();
    await vi.waitFor(() => expect(store.get().conditions.motor.active).toBe(false));
    expect(shadow().querySelector('.asl-toggle')?.textContent).toBe('Shopping assistant');
  });

  it('Escape cancels a pending suggestion; Space typed in a text field does not', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    motorEvidence();
    vi.advanceTimersByTime(SUGGEST_CHECK_MS);

    const space = new KeyboardEvent('keydown', {
      code: 'Space',
      key: ' ',
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    input.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
    expect(app.suggester.state.kind).toBe('countdown');

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(app.suggester.state.kind).toBe('idle');
    input.remove();
  });

  it('the switch key (outside text fields) cancels a pending suggestion', () => {
    motorEvidence();
    vi.advanceTimersByTime(SUGGEST_CHECK_MS);
    // A tap: Space down and up (holding it would be "talk").
    const press = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    document.body.dispatchEvent(
      new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true }),
    );
    expect(app.suggester.state.kind).toBe('idle');
  });

  it('the help phrase counts as help use for ageing inference', () => {
    const bus = createBus();
    app.unmount();
    const container = document.createElement('div');
    host.shadowRoot!.replaceChildren(container);
    app = mountApp(container, store, bus, createMockBackend());
    bus.emit({ type: 'phrase', id: 'help', text: 'Help' });
    expect(app.engine.log.map((s) => s.kind)).toEqual(['help_use']);
  });
});
