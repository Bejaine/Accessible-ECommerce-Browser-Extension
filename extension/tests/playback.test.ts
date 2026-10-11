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
import type { Player, PlayerEvent, PlayerSnapshot } from '../src/audio/player';
import { createPlayerSpeaker } from '../src/core/voice';
import { createPlaybackBar } from '../src/ui/playbackBar';
import { recordingSpeaker } from './helpers/fakeSpeaker';

const reviews = reviewsFixture as AccessibleOutput;

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

/** A small stand-in for Track A's player: same interface, records what it was asked to play. */
function fakePlayer() {
  const listeners = new Set<(e: PlayerEvent) => void>();
  const played: string[] = [];
  let items: string[] = [];
  let pos = 0;
  let state: Player['state'] = 'idle';
  let rate = 1;
  let lang: 'en' | 'hi' | 'te' = 'en';
  const emit = (e: PlayerEvent) => listeners.forEach((l) => l(e));
  const setState = (s: Player['state']) => {
    state = s;
    emit({ type: 'state', state: s });
  };
  const speak = () => {
    const text = items[pos];
    if (text === undefined) return;
    played.push(text);
    emit({ type: 'sentence', section: 0, index: pos, text, source: 'text' } as PlayerEvent);
  };
  const load = (texts: string[], l = lang) => {
    items = texts;
    lang = l;
    pos = 0;
    setState('playing');
    speak();
  };
  const player = {
    play: (sections: { segments: { text: string }[] }[], l: 'en' | 'hi' | 'te') =>
      load(
        sections.flatMap((s) => s.segments.map((x) => x.text)),
        l,
      ),
    playOutput: (o: AccessibleOutput) =>
      load([o.summary, ...o.sections.map((s) => s.heading)], o.lang),
    pause: () => state === 'playing' && setState('paused'),
    resume: () => state === 'paused' && (setState('playing'), speak()),
    toggle: () => undefined,
    stop: () => setState('idle'),
    repeatSentence: () => speak(),
    repeatAll: () => ((pos = 0), speak()),
    back: () => ((pos = Math.max(0, pos - 1)), speak()),
    nextSection: () => ((pos += 1), speak()),
    previousSection: () => ((pos = Math.max(0, pos - 1)), speak()),
    slower: () => ((rate = Math.max(0.5, rate - 0.25)), emit({ type: 'rate', rate })),
    faster: () => ((rate = Math.min(2, rate + 0.25)), emit({ type: 'rate', rate })),
    get state() {
      return state;
    },
    get rate() {
      return rate;
    },
    snapshot: (): PlayerSnapshot | null =>
      items.length
        ? ({
            sections: [{ segments: items.map((text) => ({ text })) }],
            lang,
            section: 0,
            index: pos,
          } as PlayerSnapshot)
        : null,
    restore: (snap: PlayerSnapshot) => {
      items = snap.sections[0]!.segments.map((s) => s.text);
      pos = snap.index;
      setState('playing');
      speak();
    },
    subscribe: (l: (e: PlayerEvent) => void) => (listeners.add(l), () => listeners.delete(l)),
    /** Test helper: the current clip finished and there is nothing after it. */
    finish: () => {
      setState('idle');
      emit({ type: 'end' });
    },
    textOnly: () => emit({ type: 'text-only', text: 'x' }),
  };
  return { player: player as unknown as Player & { finish(): void; textOnly(): void }, played };
}

describe("voice adapter over Track A's player", () => {
  it('plays answers through the player and reports state and the current sentence', () => {
    const { player, played } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    const seen: (string | null)[] = [];
    speaker.onChange((_, __, sentence) => seen.push(sentence));
    speaker.speakOutput(reviews);
    expect(played[0]).toBe(reviews.summary);
    expect(speaker.state).toBe('playing');
    expect(speaker.sentence).toBe(reviews.summary);
    speaker.nextSection();
    expect(played.at(-1)).toBe(reviews.sections[0]!.heading);
    expect(seen).toContain(reviews.summary);
  });

  it('short answers: only the summary and warnings', () => {
    const { player, played } = fakePlayer();
    createPlayerSpeaker(player).speakOutput(
      { ...reviews, warnings: ['Heads up.'] },
      { verbosity: 'short' },
    );
    expect(played).toEqual([reviews.summary]);
    expect(player.snapshot()!.sections[0]!.segments.map((s) => s.text)).toEqual([
      reviews.summary,
      'Heads up.',
    ]);
  });

  it('a prompt over a playing answer: the answer carries on afterwards from the same sentence', () => {
    const { player, played } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    speaker.speakOutput(reviews);
    speaker.nextSection();
    const at = played.at(-1);
    speaker.prompt('Speech speed 1.25×', 'en');
    expect(played.at(-1)).toBe('Speech speed 1.25×');
    player.finish();
    expect(played.at(-1)).toBe(at);
    expect(speaker.state).toBe('playing');
  });

  it('a prompt over a paused answer keeps it paused; Resume brings the answer back', () => {
    const { player, played } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    speaker.speakOutput(reviews);
    speaker.pause();
    speaker.prompt('Resume', 'en');
    player.finish();
    expect(speaker.state).toBe('paused');
    speaker.resume();
    expect(played.at(-1)).toBe(reviews.summary);
    expect(speaker.state).toBe('playing');
  });

  it('several lines in different languages play one after another', () => {
    const { player, played } = fakePlayer();
    createPlayerSpeaker(player).sayLines([
      { text: 'For English, press 1.', lang: 'en' },
      { text: 'हिंदी के लिए 2 दबाएँ।', lang: 'hi' },
    ]);
    expect(played).toEqual(['For English, press 1.']);
    player.finish();
    expect(played.at(-1)).toBe('हिंदी के लिए 2 दबाएँ।');
  });

  it('follows the saved speed by stepping the player (0.25 steps)', () => {
    const { player } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    speaker.setRate(0.75);
    expect(player.rate).toBe(0.75);
    speaker.setRate(1.5);
    expect(player.rate).toBe(1.5);
  });

  it('snapshot is the answer, never a prompt over it', () => {
    const { player } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    expect(speaker.snapshot()).toBeNull();
    speaker.speakOutput(reviews);
    speaker.nextSection();
    speaker.prompt('Speech speed 1.25×', 'en');
    const snap = speaker.snapshot()!;
    expect(snap.index).toBe(1);
    expect(snap.sections[0]!.segments[0]!.text).toBe(reviews.summary);
  });

  it('a position saved before a page change waits as a paused answer; Resume plays from it', () => {
    const first = fakePlayer();
    const before = createPlayerSpeaker(first.player);
    before.speakOutput(reviews);
    before.nextSection();
    const snap = before.snapshot()!;

    const { player, played } = fakePlayer(); // the next page: a new player
    const speaker = createPlayerSpeaker(player);
    const states: string[] = [];
    speaker.onChange(() => states.push(speaker.state));
    speaker.offerResume(snap);
    expect(speaker.state).toBe('paused');
    expect(played).toEqual([]); // nothing plays until the user asks
    expect(states).toContain('paused');
    speaker.prompt('Reading stopped when the page changed.', 'en');
    player.finish();
    expect(speaker.state).toBe('paused');
    speaker.resume();
    expect(played.at(-1)).toBe(reviews.sections[0]!.heading);
    expect(speaker.state).toBe('playing');
  });

  it('an offer never replaces something already playing', () => {
    const { player, played } = fakePlayer();
    const speaker = createPlayerSpeaker(player);
    speaker.say('New answer', 'en');
    speaker.offerResume({
      sections: [{ segments: [{ text: 'old' }] }],
      lang: 'en',
      section: 0,
      index: 0,
    });
    speaker.pause();
    speaker.resume();
    expect(played).not.toContain('old');
  });

  it('a language with no voice is reported once', () => {
    const { player } = fakePlayer();
    const onNoVoice = vi.fn();
    const speaker = createPlayerSpeaker(player, { onNoVoice });
    speaker.say('తెలుగు', 'te');
    player.textOnly();
    player.textOnly();
    expect(onNoVoice).toHaveBeenCalledOnce();
    expect(onNoVoice).toHaveBeenCalledWith('te');
  });
});
