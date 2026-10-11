import { describe, expect, it, vi } from 'vitest';
import { createBargeIn, isLikelyEcho } from '../src/audio/bargeIn';
import type { ListenOptions, Mic, Utterance } from '../src/audio/mic';
import type { PlayerEvent, PlayerState } from '../src/audio/player';

/** A mic whose utterances the test delivers. */
function fakeMic() {
  let pending: {
    resolve: (u: Utterance) => void;
    reject: (e: unknown) => void;
    opts: ListenOptions;
  } | null = null;
  let muted = false;
  const listens: ListenOptions[] = [];
  const mic: Mic = {
    listen: vi.fn((opts: ListenOptions = {}) => {
      if (muted) return Promise.reject({ code: 'secure_zone' });
      listens.push(opts);
      return new Promise<Utterance>((resolve, reject) => {
        pending = { resolve, reject, opts };
      });
    }),
    stop: vi.fn(() => end('stopped')),
    mute: vi.fn(() => {
      muted = true;
      end('muted');
    }),
    unmute: vi.fn(() => {
      muted = false;
    }),
    get listening() {
      return pending !== null;
    },
    get muted() {
      return muted;
    },
  };
  function end(reason: Utterance['reason'], audio = false) {
    const p = pending;
    pending = null;
    p?.resolve({
      reason,
      wav: audio ? new Uint8Array([1]) : null,
      audioBase64: audio ? 'AQ==' : null,
      durationMs: audio ? 900 : 0,
      micLevel: audio ? 0.6 : 0.02,
    });
  }
  return {
    mic,
    listens,
    speechStarts: () => pending?.opts.onSpeechStart?.(),
    say: () => end('silence', true),
    nothing: () => end('no_speech'),
    fail: (code: string) => {
      const p = pending;
      pending = null;
      p?.reject({ code });
    },
  };
}

/** A player that the test drives by emitting its events. */
function fakePlayer() {
  let state: PlayerState = 'idle';
  const listeners = new Set<(e: PlayerEvent) => void>();
  const player = {
    get state() {
      return state;
    },
    pause: vi.fn(() => {
      state = 'paused';
    }),
    resume: vi.fn(() => {
      state = 'playing';
    }),
    subscribe: (fn: (e: PlayerEvent) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = (e: PlayerEvent) => {
    if (e.type === 'state') state = e.state;
    listeners.forEach((fn) => fn(e));
  };
  return {
    player,
    start: () => emit({ type: 'state', state: 'playing' }),
    sentence: (source: 'audio' | 'device' | 'text' = 'audio', text = 'x') =>
      emit({ type: 'sentence', section: 0, index: 0, text, source }),
    userPause: () => emit({ type: 'state', state: 'paused' }),
    end: () => emit({ type: 'state', state: 'idle' }),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function setup(mode: 'default' | 'speech' = 'default', enabled = true) {
  const m = fakeMic();
  const p = fakePlayer();
  const onUtterance = vi.fn();
  const onError = vi.fn();
  const barge = createBargeIn({
    mic: m.mic,
    player: p.player,
    mode: () => mode,
    onUtterance,
    onError,
    enabled: () => enabled,
  });
  return { m, p, barge, onUtterance, onError };
}

describe('barge-in', () => {
  it('listens while an answer plays, in the current listening mode', () => {
    const t = setup('speech');
    t.p.start();
    t.p.sentence();
    expect(t.m.mic.listen).toHaveBeenCalledOnce();
    expect(t.m.listens[0]?.mode).toBe('speech');
  });

  it('pauses playback as soon as the user starts speaking', () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.speechStarts();
    expect(t.p.player.pause).toHaveBeenCalledOnce();
  });

  it('hands the finished utterance on (matcher or ASR → /turn)', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.speechStarts();
    t.m.say();
    await tick();
    expect(t.onUtterance).toHaveBeenCalledWith(expect.objectContaining({ audioBase64: 'AQ==' }));
    expect(t.p.player.resume).not.toHaveBeenCalled(); // the caller decides what happens next
  });

  it('resumeAfterBargeIn() resumes only playback that barge-in paused', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.speechStarts();
    t.m.say();
    await tick();
    t.barge.resumeAfterBargeIn(); // e.g. ASR heard nothing usable
    expect(t.p.player.resume).toHaveBeenCalledOnce();
    t.barge.resumeAfterBargeIn();
    expect(t.p.player.resume).toHaveBeenCalledOnce();
  });

  it('a false alarm (speech started, nothing recorded) resumes by itself', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.speechStarts();
    t.m.nothing();
    await tick();
    expect(t.p.player.resume).toHaveBeenCalledOnce();
    expect(t.onUtterance).not.toHaveBeenCalled();
  });

  it('never resumes playback the user paused themselves', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.p.userPause();
    t.m.nothing();
    await tick();
    t.barge.resumeAfterBargeIn();
    expect(t.p.player.resume).not.toHaveBeenCalled();
  });

  it('keeps listening while playback continues (a quiet stretch is not the end)', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.nothing();
    await tick();
    expect(t.m.mic.listen).toHaveBeenCalledTimes(2);
  });

  it('closes the mic when playback ends, unless the user is mid-sentence', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.p.end();
    expect(t.m.mic.stop).toHaveBeenCalledOnce();
    await tick();

    const u = setup();
    u.p.start();
    u.p.sentence();
    u.m.speechStarts();
    u.p.end();
    expect(u.m.mic.stop).not.toHaveBeenCalled();
    u.m.say();
    await tick();
    expect(u.onUtterance).toHaveBeenCalledOnce();
  });

  it('does not listen during device-voice segments (echo cancellation may not cover them)', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence('device');
    expect(t.m.mic.listen).not.toHaveBeenCalled();
    t.p.sentence('audio');
    expect(t.m.mic.listen).toHaveBeenCalledOnce();
    t.p.sentence('device'); // listening, user not speaking: close the mic
    expect(t.m.mic.stop).toHaveBeenCalledOnce();
  });

  it('in a secure zone (mic muted) it does not listen, and starts again after unmute', async () => {
    const t = setup();
    t.m.mic.mute();
    t.p.start();
    t.p.sentence();
    await tick();
    expect(t.m.listens).toHaveLength(0);
    expect(t.onError).not.toHaveBeenCalled(); // muting is expected, not an error
    t.m.mic.unmute();
    t.p.sentence();
    expect(t.m.listens).toHaveLength(1);
  });

  it('if the mic is not allowed, barge-in switches off for the session and says so once', async () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.m.fail('permission_denied');
    await tick();
    t.p.sentence();
    t.p.sentence();
    expect(t.m.mic.listen).toHaveBeenCalledOnce();
    expect(t.onError).toHaveBeenCalledOnce();
    expect(t.onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'permission_denied' }));
  });

  it('dispose() stops listening and ignores later playback', () => {
    const t = setup();
    t.p.start();
    t.p.sentence();
    t.barge.dispose();
    expect(t.m.mic.stop).toHaveBeenCalledOnce();
    t.p.sentence();
    expect(t.m.mic.listen).toHaveBeenCalledOnce();
  });
});

describe('barge-in safety (live phone test: the mic heard our own voice and looped)', () => {
  it('is off unless enabled: the app must opt in (e.g. a "use headphones" setting)', () => {
    const m = fakeMic();
    const p = fakePlayer();
    createBargeIn({ mic: m.mic, player: p.player, mode: () => 'default', onUtterance: vi.fn() });
    p.start();
    p.sentence();
    expect(m.mic.listen).not.toHaveBeenCalled();
  });

  it('switching it off mid-playback closes the mic', () => {
    let on = true;
    const m = fakeMic();
    const p = fakePlayer();
    createBargeIn({
      mic: m.mic,
      player: p.player,
      mode: () => 'default',
      onUtterance: vi.fn(),
      enabled: () => on,
    });
    p.start();
    p.sentence();
    on = false;
    p.sentence();
    expect(m.mic.stop).toHaveBeenCalledOnce();
  });

  it('isEcho() recognises a transcript of what it just played', () => {
    const t = setup();
    t.p.start();
    t.p.sentence('audio', 'Add Zentra Buds Air to your cart?');
    t.p.sentence('audio', 'Quantity 1, price ₹1,999.');
    expect(t.barge.isEcho('add zentra buds air to your cart')).toBe(true);
    expect(t.barge.isEcho('Quantity one price 1999')).toBe(true);
    expect(t.barge.isEcho('yes')).toBe(false);
    expect(t.barge.isEcho('show me the reviews')).toBe(false);
  });
});

describe('isLikelyEcho', () => {
  it.each([
    [
      'Add Zentra Buds Air to your cart',
      ['Add Zentra Buds Air to your cart? Quantity 1, price ₹1,999.'],
      true,
    ],
    ['अपने कार्ट में Zentra जोड़ें', ['अपने कार्ट में Zentra Buds Air जोड़ें?'], true],
    ['add this to cart', ['Customers like the battery.'], false],
    ['yes', ['Add it to your cart? Say yes or no.'], false], // too short to call it an echo
    ['', ['anything'], false],
  ])('%s', (transcript, spoken, expected) => {
    expect(isLikelyEcho(transcript, spoken)).toBe(expected);
  });
});
