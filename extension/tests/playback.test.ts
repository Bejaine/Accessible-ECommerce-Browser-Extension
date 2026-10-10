import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { AccessibleOutput } from '@shared/index';
import reviewsFixture from '../../fixtures/mocks/AccessibleOutput.json';
import type { Mic } from '../src/audio/mic';
import { mountApp, type App } from '../src/core/app';
import { createMockBackend } from '../src/core/backend';
import { createBus } from '../src/core/bus';
import { setConditionActive } from '../src/core/composer';
import { createProfileStore } from '../src/core/profile';
import { createSpeaker, sentences } from '../src/render/speaker';
import { createPlaybackBar } from '../src/ui/playbackBar';
import { recordingSpeaker } from './helpers/fakeSpeaker';

const reviews = reviewsFixture as AccessibleOutput;

/** A fake speech engine: utterances wait until the test ends them. */
function fakeSynth() {
  const spoken: { text: string; rate: number; end: () => void }[] = [];
  class Utterance {
    lang = '';
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public text: string) {}
  }
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  let active: Utterance | null = null;
  const synth = {
    speak: (u: Utterance) => {
      active = u;
      spoken.push({ text: u.text, rate: u.rate, end: () => u.onend?.() });
    },
    cancel: () => {
      active = null;
    },
  } as unknown as SpeechSynthesis;
  const finishCurrent = () => {
    const u = active;
    active = null;
    u?.onend?.();
  };
  return { synth, spoken, finishCurrent, texts: () => spoken.map((s) => s.text) };
}

describe('speaker (the assistant voice)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('never splits a number at its decimal point', () => {
    expect(sentences('It is 6.67 inches. Rated 4.2 out of 5.')).toEqual([
      'It is 6.67 inches. Rated 4.2 out of 5.',
    ]);
    expect(sentences('Speech speed 1.1×')).toEqual(['Speech speed 1.1×']);
  });

  it('splits into sentences, keeping very short ones together', () => {
    expect(
      sentences('Yes. It costs ₹99. The battery lasts two days, which buyers like a lot.'),
    ).toEqual(['Yes. It costs ₹99.', 'The battery lasts two days, which buyers like a lot.']);
  });

  it('reads the summary first, then each section, one sentence at a time', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    expect(f.texts()).toEqual([sentences(reviews.summary)[0]]);
    expect(speaker.state).toBe('playing');
    while (speaker.state === 'playing' && f.spoken.length < 50) f.finishCurrent();
    expect(f.texts()).toContain(reviews.sections[0]!.heading);
    expect(speaker.state).toBe('idle');
  });

  it('pause stops at the current sentence; resume starts it again', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    f.finishCurrent();
    const second = f.texts().at(-1);
    speaker.pause();
    expect(speaker.state).toBe('paused');
    expect(speaker.sentence).toBe(second);
    speaker.resume();
    expect(f.texts().at(-1)).toBe(second);
    expect(speaker.state).toBe('playing');
  });

  it('next / previous section, back one sentence and from the start', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    speaker.nextSection();
    expect(f.texts().at(-1)).toBe(reviews.sections[0]!.heading);
    speaker.nextSection();
    expect(f.texts().at(-1)).toBe(reviews.sections[1]!.heading);
    speaker.previousSection();
    expect(f.texts().at(-1)).toBe(reviews.sections[0]!.heading);
    f.finishCurrent();
    speaker.back();
    expect(f.texts().at(-1)).toBe(reviews.sections[0]!.heading);
    speaker.repeatAll();
    expect(f.texts().at(-1)).toBe(sentences(reviews.summary)[0]);
  });

  it('a prompt over a playing answer resumes the answer afterwards; over a paused one it stays paused', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    const first = f.texts().at(-1);
    speaker.prompt('Speech speed 1.1×', 'en');
    expect(f.texts().at(-1)).toBe('Speech speed 1.1×');
    f.finishCurrent();
    expect(f.texts().at(-1)).toBe(first);

    speaker.pause();
    speaker.prompt('Resume', 'en');
    f.finishCurrent();
    expect(speaker.state).toBe('paused');
    expect(f.texts().at(-1)).toBe('Resume');
  });

  it('a new speed applies straight away (the sentence restarts at the new rate)', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    speaker.setRate(0.8);
    expect(f.spoken.at(-1)).toMatchObject({ text: f.spoken[0]!.text, rate: 0.8 });
  });

  it('stop empties the queue', () => {
    const f = fakeSynth();
    const speaker = createSpeaker({ synth: f.synth });
    speaker.speakOutput(reviews);
    speaker.stop();
    expect(speaker.state).toBe('idle');
    expect(speaker.sentence).toBeNull();
  });
});

describe('playback bar', () => {
  it('is hidden when idle, shows the current sentence, and flips Pause / Resume', () => {
    const onAction = vi.fn();
    const bar = createPlaybackBar(onAction);
    bar.update('idle', null);
    expect(bar.element.hidden).toBe(true);
    bar.update('playing', 'The battery lasts two days.');
    expect(bar.element.hidden).toBe(false);
    expect(bar.element.querySelector('.asl-now')?.textContent).toBe('The battery lasts two days.');
    const play = bar.element.querySelector<HTMLButtonElement>('.asl-play')!;
    expect(play.textContent).toBe('Pause');
    play.click();
    expect(onAction).toHaveBeenCalledWith('toggle');
    bar.update('paused', 'The battery lasts two days.');
    expect(play.textContent).toBe('Resume');
    const names = [...bar.element.querySelectorAll('button')].map((b) => b.textContent);
    expect(names).toEqual([
      'Resume',
      'Repeat sentence',
      'Next section',
      'Stop',
      'More',
      'Back one sentence',
      'Previous section',
      'From the start',
      'Slower',
      'Faster',
    ]);
  });
});

describe('playback in the app: single key, mini-menu and voice words', () => {
  let host: HTMLElement;
  let app: App;
  let rec: ReturnType<typeof recordingSpeaker>;

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.useFakeTimers();
    const store = await createProfileStore();
    await store.update((d) => setConditionActive(d, 'visual', true, 'user', 1));
    host = document.createElement('div');
    const container = document.createElement('div');
    host.attachShadow({ mode: 'open' }).appendChild(container);
    document.body.appendChild(host);
    rec = recordingSpeaker();
    const mic = {
      listening: false,
      muted: false,
      listen: () => new Promise(() => undefined),
      stop: () => undefined,
      mute: () => undefined,
      unmute: () => undefined,
    } as unknown as Mic;
    app = mountApp(container, store, createBus(), createMockBackend(), {
      speaker: rec.speaker,
      mic,
    });
  });

  afterEach(() => {
    app.unmount();
    host.remove();
    vi.useRealTimers();
  });

  it('read-aloud users get the answer spoken and the playback bar with the current sentence', async () => {
    await app.say('help', 'text');
    expect(rec.calls).toContain('speakOutput');
    const bar = host.shadowRoot!.querySelector<HTMLElement>('.asl-playback')!;
    expect(bar.hidden).toBe(false);
    expect(bar.querySelector('.asl-now')?.textContent).toContain('You can press a phrase button');
  });

  it('the key pauses; after 1.5 s the mini-menu is read out; the key then picks the highlighted item', async () => {
    await app.say('help', 'text');
    app.playbackKey();
    expect(rec.speaker.state).toBe('paused');
    await vi.advanceTimersByTimeAsync(1500);
    expect(rec.calls).toContain('prompt:Resume');
    expect(host.shadowRoot!.querySelector('.asl-highlight')?.textContent).toBe('Resume');
    app.playbackKey();
    expect(rec.speaker.state).toBe('playing');
  });

  it('a quick second press resumes without waiting for the menu', async () => {
    await app.say('help', 'text');
    app.playbackKey();
    app.playbackKey();
    expect(rec.speaker.state).toBe('playing');
    await vi.advanceTimersByTimeAsync(2000);
    expect(rec.calls.some((c) => c.startsWith('prompt:Resume'))).toBe(false);
  });

  it('playback words work by voice without a server call', async () => {
    await app.say('help', 'text');
    for (const [word, call] of [
      ['pause', 'pause'],
      ['resume', 'resume'],
      ['repeat that', 'repeatSentence'],
      ['next section', 'nextSection'],
      ['previous section', 'previousSection'],
      ['go back', 'back'],
      ['stop', 'stop'],
    ] as const) {
      await app.say(word);
      expect(rec.calls.at(-1), word).toBe(call);
    }
  });
});
