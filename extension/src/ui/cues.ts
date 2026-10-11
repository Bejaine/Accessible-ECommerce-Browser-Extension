// Listening cues: a short rising chime when the assistant starts listening, a falling one when it
// stops (dev/make-cues.mjs makes the files). They play through Track A's player like pre-recorded
// UI phrases (rule 12): the app's phraseUrl lookup answers these keys with the bundled files.
// A tone, not a word: it never sounds like the start of an answer, and it is over in 0.2 s.
import doneUrl from './cues/done.wav?url&inline';
import listenUrl from './cues/listen.wav?url&inline';

export type Cue = 'listen' | 'done';

export const CUE_KEYS: Record<Cue, string> = { listen: 'cue.listen', done: 'cue.done' };

/** How long a cue lasts (e.g. before carrying on with a paused answer). */
export const CUE_MS = 200;

const URLS: Record<string, string> = {
  [CUE_KEYS.listen]: listenUrl,
  [CUE_KEYS.done]: doneUrl,
};

/** The cue's audio file for a phrase key, or null for any other key. */
export function cueUrl(key: string): string | null {
  return URLS[key] ?? null;
}
