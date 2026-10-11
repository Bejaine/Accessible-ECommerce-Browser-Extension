// The device voice for Track A's player (passed in as its `engines.device`), made dependable:
// - Pause / resume: Chrome on Linux (speech-dispatcher) and Android ignore
//   speechSynthesis.pause() / resume(), so the voice kept talking after "Pause". Here pause
//   cancels the sentence and resume says that sentence again from its start (sentences are short).
// - A new sentence right after cancel() can be dropped by Chrome; speaking waits a moment then.
// Server (Bhashini) audio keeps Track A's own engine: an <audio> element pauses fine.
import { browserEngines, type Engines, type Playback } from '../audio/player';

/** Chrome may drop an utterance spoken within this long after cancel(). */
export const AFTER_CANCEL_MS = 120;

interface Synth {
  speak(u: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export function deviceVoice(
  /** Default: the browser's speechSynthesis, looked up when first used. */
  given?: Synth,
  makeUtterance: (text: string) => SpeechSynthesisUtterance = (t) =>
    new SpeechSynthesisUtterance(t),
  now: () => number = () => performance.now(),
): Engines['device'] {
  const synth = (): Synth => given ?? speechSynthesis;
  let lastCancel = -Infinity;
  const cancel = () => {
    lastCancel = now();
    synth().cancel();
  };

  return (text, voice, rate): Playback => {
    let finish!: () => void;
    let fail!: (e: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
    let settled = false;
    let paused = false;
    let speakRate = rate;
    let attempt = 0; // a cancelled utterance's late events must not end the new one
    let timer: ReturnType<typeof setTimeout> | undefined;

    function speak(): void {
      const mine = ++attempt;
      const u = makeUtterance(text);
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = speakRate;
      u.onend = () => {
        if (mine !== attempt || paused || settled) return;
        settled = true;
        finish();
      };
      u.onerror = (e) => {
        if (mine !== attempt || paused || settled) return;
        settled = true;
        // Cancelled by someone else (not our pause/stop, which change `attempt`): just move on.
        if (e.error === 'interrupted' || e.error === 'canceled') finish();
        else fail(new Error(e.error));
      };
      const wait = AFTER_CANCEL_MS - (now() - lastCancel);
      if (wait > 0) timer = setTimeout(() => !paused && !settled && synth().speak(u), wait);
      else synth().speak(u);
    }
    speak();

    return {
      done,
      pause() {
        if (paused || settled) return;
        paused = true;
        clearTimeout(timer);
        attempt++; // ignore the cancelled utterance's events
        cancel();
      },
      resume() {
        if (!paused || settled) return;
        paused = false;
        speak();
      },
      stop() {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        attempt++;
        cancel();
        finish();
      },
      setRate(next) {
        speakRate = next; // used from the next sentence (or a resumed one)
      },
    };
  };
}

/** Track A's engines with the dependable device voice. */
export function playerEngines(): Engines {
  return { audio: browserEngines().audio, device: deviceVoice() };
}
