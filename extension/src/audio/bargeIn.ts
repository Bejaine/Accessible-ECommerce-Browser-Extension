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
import type { ListenMode, Mic, Utterance } from './mic';
import type { PlayerEvent, PlayerState } from './player';

interface PlayerLike {
  readonly state: PlayerState;
  pause(): void;
  resume(): void;
  subscribe(listener: (event: PlayerEvent) => void): () => void;
}

export interface BargeIn {
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
}): BargeIn {
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
    if (disposed || disabled || listening || deviceVoice || deps.mic.muted) return;
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
      deviceVoice = event.source === 'device';
      if (deviceVoice) closeUnlessSpeaking();
      else listen();
    } else if (event.type === 'state') {
      if (event.state === 'playing') pausedByUs = false; // a new answer, or resumed
      if (event.state === 'idle') closeUnlessSpeaking();
    }
  });

  return {
    resumeAfterBargeIn,
    dispose() {
      disposed = true;
      unsubscribe();
      if (listening) deps.mic.stop();
    },
  };
}
