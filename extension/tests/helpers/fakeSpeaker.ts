import type { PlaybackState, Speaker } from '../../src/core/voice';

/** A Speaker that records calls and tracks state like the real one, without audio. */
export function recordingSpeaker() {
  const calls: string[] = [];
  let state: PlaybackState = 'idle';
  let sentence: string | null = null;
  const listeners = new Set<(s: boolean, st: PlaybackState, sentence: string | null) => void>();
  const set = (next: PlaybackState, text: string | null = sentence) => {
    state = next;
    sentence = text;
    listeners.forEach((l) => l(state === 'playing', state, sentence));
  };
  const speaker: Speaker = {
    speakOutput: (o) => (calls.push('speakOutput'), set('playing', o.summary)),
    say: (text) => (calls.push(`say:${text}`), set('playing', text)),
    sayLines: () => (calls.push('sayLines'), set('playing')),
    prompt: (text) => calls.push(`prompt:${text}`),
    pause: () => (calls.push('pause'), state === 'playing' && set('paused')),
    resume: () => (calls.push('resume'), state === 'paused' && set('playing')),
    repeatSentence: () => (calls.push('repeatSentence'), set('playing')),
    repeatAll: () => (calls.push('repeatAll'), set('playing')),
    back: () => (calls.push('back'), set('playing')),
    nextSection: () => (calls.push('nextSection'), set('playing')),
    previousSection: () => (calls.push('previousSection'), set('playing')),
    stop: () => (calls.push('stop'), set('idle', null)),
    setRate: (r) => calls.push(`rate:${r}`),
    snapshot: () => null,
    offerResume: () => (calls.push('offerResume'), set('paused')),
    get state() {
      return state;
    },
    get speaking() {
      return state === 'playing';
    },
    get sentence() {
      return sentence;
    },
    onChange: (l) => (listeners.add(l), () => listeners.delete(l)),
  };
  return { speaker, calls };
}
