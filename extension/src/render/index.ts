// Renderers turn AccessibleOutput into speech, large text, etc. (rule 4).
// STUB: only the spoken-summary queue exists.
import type { AccessibleOutput } from '@shared/index';

/** Sentences to queue in the audio player: the summary is always spoken first. */
export function toSpeechQueue(output: AccessibleOutput): string[] {
  return [output.summary];
}
