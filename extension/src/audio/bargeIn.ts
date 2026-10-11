// Interrupting playback by speaking (Track A). docs/conditions.md: during playback the mic
// runs with echo cancellation and local VAD; detected speech pauses playback, then the local
// matcher handles playback words and anything else goes through the normal turn.
//
// - Listens while an answer is playing or paused; the mic closes when playback ends (unless
//   the user is mid-sentence). Speech start pauses playback.
// - The finished utterance goes to `onUtterance` (integration: Track D's matcher, else ASR →
//   /turn). A false alarm (nothing recorded) resumes by itself; `resumeAfterBargeIn()` lets the
//   caller resume if ASR heard nothing usable. Playback the user paused is never resumed here.
// - Not during device-voice segments: echo cancellation covers audio the page plays, but the
//   device voice is played by the OS and could be heard as the user speaking.
// - Secure zone (mic muted): no listening. Mic refused: off for the session, reported once.
// - OFF unless `enabled()` says so. Live phone test (2026-10-11): from the phone's speaker the
//   mic heard our own answer, paused it, and sent it back as a new command, in a loop. Echo
//   cancellation is not enough on phones, so the app opts in (e.g. a "use headphones"
//   setting) and should drop transcripts for which `isEcho()` is true.
import type { ListenMode, Mic, Utterance } from './mic';
import type { PlayerEvent, PlayerState } from './player';

interface PlayerLike {
  readonly state: PlayerState;
  pause(): void;
  resume(): void;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
}

export interface BargeIn {
  /** True if a transcript is just our own recent speech heard back (drop it, don't send it). */
  isEcho(transcript: string): boolean;
  /** Resume playback that barge-in paused (e.g. ASR found no words). No-op otherwise. */
  resumeAfterBargeIn(): void;
  dispose(): void;
}

export function createBargeIn(deps: {
  mic: Mic;
  player: PlayerLike;
  /** 'speech' when the speech condition is active (patient 2.5 s silence timeout). */
  mode: () => ListenMode;
  onUtterance: (utterance: Utterance) => void;
  /** The mic could not be used (MicError): barge-in is off for this session. */
  onError?: (error: unknown) => void;
  /** Listen during playback at all? Default false (see the note above). */
  enabled?: () => boolean;
}): BargeIn {
  const enabled = deps.enabled ?? (() => false);
  const recent: string[] = []; // texts of the last segments played, for isEcho()
  let listening = false;
  let speaking = false;
  let pausedByUs = false;
  let deviceVoice = false;
  let disabled = false;
  let disposed = false;

  function resumeAfterBargeIn() {
    if (pausedByUs && deps.player.state === 'paused') {
      pausedByUs = false;
      deps.player.resume();
    }
  }

  function listen() {
    if (disposed || disabled || listening || deviceVoice || deps.mic.muted || !enabled()) return;
    if (deps.player.state === 'idle') return;
    listening = true;
    speaking = false;
    deps.mic
      .listen({
        mode: deps.mode(),
        onSpeechStart: () => {
          speaking = true;
          if (deps.player.state === 'playing') {
            pausedByUs = true;
            deps.player.pause();
          }
        },
      })
      .then(
        (u) => {
          listening = false;
          speaking = false;
          if (disposed || u.reason === 'muted') return;
          if (u.audioBase64) deps.onUtterance(u);
          else resumeAfterBargeIn(); // a false alarm: carry on
          listen(); // keep listening while there is playback (playing or paused)
        },
        (error: unknown) => {
          listening = false;
          speaking = false;
          if ((error as { code?: string } | null)?.code === 'secure_zone') return; // expected
          disabled = true;
          deps.onError?.(error);
        },
      );
  }

  function closeUnlessSpeaking() {
    if (listening && !speaking) deps.mic.stop();
  }

  const unsubscribe = deps.player.subscribe((event) => {
    if (disposed) return;
    if (event.type === 'sentence') {
      recent.push(event.text);
      if (recent.length > RECENT_SEGMENTS) recent.shift();
      deviceVoice = event.source === 'device';
      if (deviceVoice || !enabled()) closeUnlessSpeaking();
      else listen();
    } else if (event.type === 'state') {
      if (event.state === 'playing') pausedByUs = false; // a new answer, or resumed
      if (event.state === 'idle') closeUnlessSpeaking();
    }
  });

  return {
    isEcho: (transcript) => isLikelyEcho(transcript, recent),
    resumeAfterBargeIn,
    dispose() {
      disposed = true;
      unsubscribe();
      if (listening) deps.mic.stop();
    },
  };
}

const RECENT_SEGMENTS = 6;
const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
];

function words(text: string): string[] {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/(?<=\d),(?=\d)/g, '') // 1,999 -> 1999
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ') // punctuation, ₹
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (NUMBER_WORDS.includes(w) ? String(NUMBER_WORDS.indexOf(w)) : w));
}

/** At least 3 words, of which at least 80% occur in what we just said: our own voice heard
 *  back. A real command that merely shares words with it ("add this to cart" while we said "Add
 *  Zentra Buds Air to your cart?") stays below that. */
export function isLikelyEcho(transcript: string, spoken: string[]): boolean {
  const heard = words(transcript);
  if (heard.length < 3) return false;
  const said = new Set(spoken.flatMap(words));
  return heard.filter((w) => said.has(w)).length / heard.length >= 0.8;
}
