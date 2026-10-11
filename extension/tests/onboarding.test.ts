import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { resolveMode, setConditionActive } from '../src/core/composer';
import {
  createProfileStore,
  isOnboarded,
  markOnboarded,
  type ProfileStore,
} from '../src/core/profile';
import { resetAnnouncer } from '../src/ui/announce';
import { HOLD_MS, startOnboarding, type Onboarding } from '../src/ui/onboarding';
import { createSettings } from '../src/ui/settings';
import { label } from '../src/ui/strings';

describe('first-run onboarding', () => {
  let root: HTMLElement;
  let store: ProfileStore;
  let onboarding: Onboarding;
  let onDone: ReturnType<typeof vi.fn<() => void>>;

  const buttons = () => [...root.querySelectorAll<HTMLButtonElement>('.asl-option')];
  /** A key press: down and up (a quick Space press is a tap; holding it would be "talk"). */
  const key = (k: string, code = k) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, cancelable: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: k, code, cancelable: true }));
  };
  const live = () => root.querySelector('#asl-live')?.textContent ?? '';

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    root = document.createElement('div');
    document.body.append(root);
    store = await createProfileStore();
    onDone = vi.fn<() => void>();
  });

  afterEach(() => {
    onboarding?.dispose();
    resetAnnouncer();
    root.remove();
    vi.useRealTimers();
  });

  it('asks for the language in all three languages, each marked with its language', async () => {
    onboarding = startOnboarding({ root, store, onDone });
    expect(root.querySelector('h1')?.textContent).toBe('Language · भाषा · భాష');
    expect(
      [...root.querySelectorAll('p.asl-question[lang]')].map((p) => p.getAttribute('lang')),
    ).toEqual(['en', 'hi', 'te']);
    expect(root.querySelector('p.asl-purpose')?.textContent).toContain(
      'Setting up the Shopping assistant',
    );
    expect(buttons().map((b) => [b.textContent, b.lang])).toEqual([
      ['1. English', 'en'],
      ['2. हिंदी', 'hi'],
      ['3. తెలుగు', 'te'],
    ]);
    expect(document.activeElement).toBe(root.querySelector('h1'));
    await vi.advanceTimersByTimeAsync(100);
    expect(live()).toContain('हिंदी के लिए');
  });

  it('number keys answer each question and seed the profile as user choices', async () => {
    onboarding = startOnboarding({ root, store, onDone });
    key('2');
    await vi.waitFor(() => expect(onboarding.step).toBe('read_aloud'));
    expect(store.get().prefs.lang).toBe('hi');
    key('1');
    await vi.waitFor(() => expect(onboarding.step).toBe('colour'));
    expect(store.get().conditions.visual).toMatchObject({ active: true, source: 'user' });
    key('n');
    await vi.waitFor(() => expect(onboarding.step).toBe('done'));
    expect(store.get().conditions.colour.active).toBe(false);
    expect(await isOnboarded()).toBe(true);
    const finish = await vi.waitFor(() => {
      const button = root.querySelector<HTMLButtonElement>('.asl-primary');
      if (!button) throw new Error('Finish not rendered yet');
      return button;
    });
    finish.click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('taps answer too', async () => {
    onboarding = startOnboarding({ root, store, onDone });
    buttons()[0]!.click();
    await vi.waitFor(() => expect(onboarding.step).toBe('read_aloud'));
    buttons()[1]!.click();
    await vi.waitFor(() => expect(onboarding.step).toBe('colour'));
    buttons()[0]!.click();
    await vi.waitFor(() =>
      expect(store.get().conditions.colour).toMatchObject({ active: true, source: 'user' }),
    );
    expect(store.get().conditions.visual.active).toBe(false);
  });

  it('one switch: the first Space starts stepping through the choices aloud, the next picks', async () => {
    onboarding = startOnboarding({ root, store, onDone, scanIntervalMs: 1000 });
    key(' ', 'Space');
    expect(root.querySelector('.asl-highlight')?.textContent).toBe('1. English');
    await vi.advanceTimersByTimeAsync(1000);
    expect(root.querySelector('.asl-highlight')?.textContent).toBe('2. हिंदी');
    expect(live()).toContain('हिंदी');
    key(' ', 'Space');
    await vi.waitFor(() => expect(store.get().prefs.lang).toBe('hi'));
  });

  it('hold Space and say the answer; letting go sends it (tap is still the switch)', async () => {
    let stop: (() => void) | null = null;
    const listen = vi.fn(
      ({ hold = false } = {}) =>
        new Promise<string | null>((resolve) => {
          expect(hold).toBe(true);
          stop = () => resolve('hindi');
        }),
    );
    onboarding = startOnboarding({ root, store, onDone, listen, stopListening: () => stop?.() });
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', cancelable: true }),
    );
    await vi.advanceTimersByTimeAsync(HOLD_MS + 10);
    expect(listen).toHaveBeenCalledOnce();
    expect(root.querySelector('.asl-highlight')).toBeNull(); // holding is not the switch
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', code: 'Space', cancelable: true }),
    );
    await vi.waitFor(() => expect(store.get().prefs.lang).toBe('hi'));
  });

  it('voice: a recognised answer is accepted; anything else asks for a number instead', async () => {
    const answers = ['telugu', 'pineapple'];
    onboarding = startOnboarding({
      root,
      store,
      onDone,
      listen: async () => answers.shift() ?? null,
    });
    root.querySelector<HTMLButtonElement>('.asl-speak')!.click();
    await vi.waitFor(() => expect(store.get().prefs.lang).toBe('te'));
    root.querySelector<HTMLButtonElement>('.asl-speak')!.click();
    await vi.advanceTimersByTimeAsync(100);
    // Telugu was just chosen, so the reply is in Telugu.
    expect(live()).toBe(label('onboarding.not_understood', 'te'));
    expect(onboarding.step).toBe('read_aloud');
  });

  it('skip finishes with defaults and is remembered', async () => {
    onboarding = startOnboarding({ root, store, onDone });
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Skip setup')!.click();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(await isOnboarded()).toBe(true);
    expect(store.get().conditions.visual.active).toBe(false);
  });

  it('first-run state lives on the device', async () => {
    expect(await isOnboarded()).toBe(false);
    await markOnboarded();
    expect(await isOnboarded()).toBe(true);
  });
});

describe('settings panel', () => {
  let store: ProfileStore;
  beforeEach(async () => {
    fakeBrowser.reset();
    store = await createProfileStore();
  });

  it('shows what is in effect and where each mode came from, and every control changes it', async () => {
    let voice = false;
    let dwellMs: number | null = null;
    const onStartScanning = vi.fn();
    const onRunSetup = vi.fn();
    const settings = createSettings({
      store,
      onStartScanning,
      onRunSetup,
      voice: { get: () => voice, set: (on) => (voice = on) },
      dwell: { get: () => dwellMs, set: (ms) => (dwellMs = ms) },
    });
    const el = settings.element;
    document.body.append(el); // inputs fire change only when attached (as in the overlay)
    const render = () => settings.render(store.get(), resolveMode(store.get()));
    store.subscribe(render);
    render();

    // A page with a heading, "Back to menu", a summary of what is in effect, then sections.
    expect(settings.button.textContent).toBe('Settings');
    expect(el.querySelector('h3')?.textContent).toBe('Settings');
    expect(el.querySelector('.asl-now-box')?.textContent).toBe(
      'Right now5 choices at a time, speech 1.0×, scanning every 1.5 seconds.',
    );
    expect([...el.querySelectorAll('fieldset > legend')].map((l) => l.textContent)).toEqual([
      'Modes',
      'Voice',
      'Text and language',
      'Pointer and switch',
    ]);

    // An automatically applied mode says so, and can be turned off here.
    await store.update((d) => setConditionActive(d, 'motor', true, 'inferred', 0.8));
    const motorRow = [...el.querySelectorAll('fieldset label')][1]!;
    expect(motorRow.textContent).toBe(
      'Easy-press mode(turned on automatically; you can turn it off)',
    );
    motorRow.querySelector('input')!.click();
    await vi.waitFor(() => expect(store.get().conditions.motor.active).toBe(false));

    // Turning a mode on by hand says "you turned this on" and updates what's in effect.
    const ageing = [...el.querySelectorAll('fieldset label')][3]!;
    ageing.querySelector('input')!.click();
    await vi.waitFor(() =>
      expect(store.get().conditions.ageing).toMatchObject({ active: true, source: 'user' }),
    );
    expect(ageing.textContent).toContain('(you turned this on)');
    expect(el.querySelector('.asl-now-box')?.textContent).toContain(
      '3 choices at a time, speech 0.75×',
    );

    const named = (name: string) =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name)!;
    named('Larger').click();
    await vi.waitFor(() => expect(store.get().prefs.text_scale).toBe(1.25));
    const reading = [...el.querySelectorAll('fieldset')].find(
      (f) => f.querySelector('legend')?.textContent === 'Voice',
    )!;
    const boxes = [...reading.querySelectorAll<HTMLInputElement>('label input')];
    boxes[0]!.click(); // assistant voice
    expect(voice).toBe(true);
    boxes[1]!.click(); // short answers
    await vi.waitFor(() => expect(store.get().prefs.verbosity).toBe('short'));

    named('Change switch key').click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }));
    await vi.waitFor(() => expect(store.get().prefs.switch_key).toBe('Enter'));
    expect(el.textContent).toContain('Switch key: Enter');

    const select = [...el.querySelectorAll('select')].find((s) => s.querySelector('[value="te"]'))!;
    select.value = 'te';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(store.get().prefs.lang).toBe('te'));

    // Dwell to click: off by default; turning it on uses the chosen resting time.
    const dwellBox = [...el.querySelectorAll('label')]
      .find((l) => l.textContent?.includes('resting the pointer'))!
      .querySelector('input')!;
    expect(dwellBox.checked).toBe(false);
    dwellBox.click();
    expect(dwellMs).toBe(1200);
    const dwellTime = [...el.querySelectorAll('select')].find((s) =>
      s.querySelector('[value="2000"]'),
    )!;
    dwellTime.value = '2000';
    dwellTime.dispatchEvent(new Event('change'));
    expect(dwellMs).toBe(2000);
    dwellBox.click();
    expect(dwellMs).toBeNull();

    named('Start switch scanning').click();
    named('Run setup again').click();
    expect(onStartScanning).toHaveBeenCalled();
    expect(onRunSetup).toHaveBeenCalled();
    el.remove();
  });
});
