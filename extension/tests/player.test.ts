import type { AccessibleOutput } from '@shared/index';
import { describe, expect, it, vi } from 'vitest';
import {
  createPlayer,
  type Engines,
  type PlayerEvent,
  type PlaySection,
} from '../src/audio/player';
import type { Segment, SpeechSource, SpeechSources } from '../src/audio/sources';

/** Engines whose clips finish only when the test says so. */
function fakeEngines() {
  const started: { what: string; rate: number; finish: () => void; fail: () => void }[] = [];
  const control = vi.fn();
  const engine =
    (kind: string) =>
    (what: string, rate: number): ReturnType<Engines['audio']> => {
      let finish!: () => void;
      let fail!: () => void;
      const done = new Promise<void>((res, rej) => {
        finish = res;
        fail = () => rej(new Error('broken clip'));
      });
      const clip = { what: `${kind}:${what}`, rate, finish, fail };
      started.push(clip);
      return {
        done,
        pause: () => control('pause', clip.what),
        resume: () => control('resume', clip.what),
        stop: () => control('stop', clip.what),
        setRate: (r: number) => {
          clip.rate = r;
          control('rate', r);
        },
      };
    };
  const engines: Engines = {
    audio: (url, rate) => engine('audio')(url, rate),
    device: (text, _voice, rate) => engine('device')(text, rate),
  };
  return { engines, started, control };
}

function fakeSources(
  map: (seg: Segment) => SpeechSource = (s) => ({ kind: 'audio', url: s.text, from: 'server' }),
) {
  const resolved: string[] = [];
  const prefetched: string[] = [];
  const sources: SpeechSources = {
    resolve: async (seg) => {
      resolved.push(seg.text);
      return map(seg);
    },
    prefetch: (seg) => prefetched.push(seg.text),
    clear: () => {},
  };
  return { sources, resolved, prefetched };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

const SECTIONS: PlaySection[] = [
  { segments: [{ text: 'Summary one.' }, { text: 'Summary two.' }] },
  { segments: [{ text: 'Good points.' }, { text: 'Battery lasts.' }] },
  { segments: [{ text: 'Drawbacks.' }, { text: 'Camera is average.' }] },
];

function setup(map?: (seg: Segment) => SpeechSource, rate = 1) {
  const f = fakeEngines();
  const s = fakeSources(map);
  const events: PlayerEvent[] = [];
  const player = createPlayer({
    sources: s.sources,
    engines: f.engines,
    rate,
    onEvent: (e) => events.push(e),
  });
  const playing = () => f.started.at(-1)?.what;
  const finish = async () => {
    f.started.at(-1)?.finish();
    await tick();
  };
  return { player, events, playing, finish, ...f, ...s };
}

describe('player', () => {
  it('plays every segment in order and reports each one for highlighting', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    const heard = [];
    for (let i = 0; i < 6; i++) {
      heard.push(t.playing());
      await t.finish();
    }
    expect(heard).toEqual([
      'audio:Summary one.',
      'audio:Summary two.',
      'audio:Good points.',
      'audio:Battery lasts.',
      'audio:Drawbacks.',
      'audio:Camera is average.',
    ]);
    const sentences = t.events.filter((e) => e.type === 'sentence');
    expect(sentences[2]).toEqual({ type: 'sentence', section: 1, index: 0, text: 'Good points.' });
    expect(t.events.at(-1)).toEqual({ type: 'end' });
    expect(t.player.state).toBe('idle');
  });

  it('prefetches the next segment while the current one plays', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    expect(t.prefetched).toEqual(['Summary two.']);
  });

  it('pause and resume act on the playing clip; toggle is the single key', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.toggle();
    expect(t.player.state).toBe('paused');
    expect(t.control).toHaveBeenCalledWith('pause', 'audio:Summary one.');
    t.player.toggle();
    expect(t.player.state).toBe('playing');
    expect(t.control).toHaveBeenCalledWith('resume', 'audio:Summary one.');
  });

  it('repeat sentence replays the current one (from cache: same source, no new TTS)', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    await t.finish(); // now on "Summary two."
    t.player.repeatSentence();
    await tick();
    expect(t.control).toHaveBeenCalledWith('stop', 'audio:Summary two.');
    expect(t.playing()).toBe('audio:Summary two.');
  });

  it('back goes to the previous sentence, repeat all to the start', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    await t.finish();
    await t.finish(); // on "Good points."
    t.player.back();
    await tick();
    expect(t.playing()).toBe('audio:Summary two.');
    t.player.repeatAll();
    await tick();
    expect(t.playing()).toBe('audio:Summary one.');
  });

  it('next and previous section jump to section starts', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.nextSection();
    await tick();
    expect(t.playing()).toBe('audio:Good points.');
    t.player.nextSection();
    await tick();
    expect(t.playing()).toBe('audio:Drawbacks.');
    await t.finish(); // "Camera is average."
    t.player.previousSection(); // mid-section: back to this section's start
    await tick();
    expect(t.playing()).toBe('audio:Drawbacks.');
    t.player.previousSection(); // at a section start: the one before
    await tick();
    expect(t.playing()).toBe('audio:Good points.');
  });

  it('a jump while paused starts playing (the paused mini-menu)', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.pause();
    t.player.nextSection();
    await tick();
    expect(t.player.state).toBe('playing');
    expect(t.playing()).toBe('audio:Good points.');
  });

  it('stop ends playback and nothing more is played', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.stop();
    await t.finish();
    expect(t.player.state).toBe('idle');
    expect(t.started).toHaveLength(1);
    expect(t.control).toHaveBeenCalledWith('stop', 'audio:Summary one.');
  });

  it('slower/faster change the rate of the playing clip, within 0.5–2, and report it', async () => {
    const t = setup(undefined, 1.75);
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.faster();
    t.player.faster(); // capped at 2
    expect(t.player.rate).toBe(2);
    expect(t.started[0]?.rate).toBe(2);
    for (let i = 0; i < 10; i++) t.player.slower();
    expect(t.player.rate).toBe(0.5);
    expect(t.events.filter((e) => e.type === 'rate').at(-1)).toEqual({ type: 'rate', rate: 0.5 });
    await t.finish();
    expect(t.started[1]?.rate).toBe(0.5); // the next clip starts at the new rate
  });

  it('uses the device voice for device sources', async () => {
    const voice = { lang: 'hi-IN' } as SpeechSynthesisVoice;
    const t = setup(() => ({ kind: 'device', voice, lang: 'hi' }));
    t.player.play([{ segments: [{ text: 'नमस्ते।' }] }], 'hi');
    await tick();
    expect(t.playing()).toBe('device:नमस्ते।');
  });

  it('text-only segments are reported for display and playback continues', async () => {
    const t = setup((s) =>
      s.text === 'Summary two.' ? { kind: 'text' } : { kind: 'audio', url: s.text, from: 'server' },
    );
    t.player.play(SECTIONS, 'en');
    await tick();
    await t.finish();
    expect(t.events).toContainEqual({ type: 'text-only', text: 'Summary two.' });
    expect(t.playing()).toBe('audio:Good points.');
  });

  it('a broken clip is reported and skipped, not fatal', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.started[0]?.fail();
    await tick();
    expect(t.events).toContainEqual({ type: 'error', text: 'Summary one.' });
    expect(t.playing()).toBe('audio:Summary two.');
  });

  it('playing new content replaces what was playing', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    t.player.play([{ segments: [{ text: 'New answer.' }] }], 'en');
    await tick();
    expect(t.control).toHaveBeenCalledWith('stop', 'audio:Summary one.');
    expect(t.playing()).toBe('audio:New answer.');
    await t.finish();
    expect(t.player.state).toBe('idle'); // the old queue is gone
  });

  it('snapshot and restore resume where a page change interrupted', async () => {
    const t = setup();
    t.player.play(SECTIONS, 'en');
    await tick();
    await t.finish();
    await t.finish(); // on "Good points."
    const snap = t.player.snapshot();
    expect(snap).toMatchObject({ lang: 'en', section: 1, index: 0 });
    const u = setup();
    u.player.restore(JSON.parse(JSON.stringify(snap)));
    await tick();
    expect(u.playing()).toBe('audio:Good points.');
  });

  it('snapshot is null when nothing is playing', () => {
    expect(setup().player.snapshot()).toBeNull();
  });
});

describe('playOutput', () => {
  it('speaks the summary, then each section heading, its items and spoken table', async () => {
    const output = {
      lang: 'hi',
      summary: 'ग्राहक बैटरी पसंद करते हैं। कैमरा औसत है।',
      sections: [
        {
          heading: 'अच्छी बातें',
          items: [{ text: 'बैटरी पूरे दिन चलती है।', kind: 'pro', grounding_index: 0 }],
          table: null,
          simpler: null,
        },
        {
          heading: 'तुलना',
          items: [],
          table: { columns: [], rows: [], spoken: 'यह फ़ोन सस्ता है।' },
          simpler: null,
        },
      ],
      simpler: null,
      followups: ['हाँ'],
      grounding: [],
      warnings: [],
    } as unknown as AccessibleOutput;
    const t = setup();
    t.player.playOutput(output);
    await tick();
    const heard = [];
    for (let i = 0; i < 6 && t.player.state === 'playing'; i++) {
      heard.push(t.playing());
      await t.finish();
    }
    expect(heard).toEqual([
      'audio:ग्राहक बैटरी पसंद करते हैं।',
      'audio:कैमरा औसत है।',
      'audio:अच्छी बातें',
      'audio:बैटरी पूरे दिन चलती है।',
      'audio:तुलना',
      'audio:यह फ़ोन सस्ता है।',
    ]);
    expect(t.resolved[0]).toBe('ग्राहक बैटरी पसंद करते हैं।');
  });
});
