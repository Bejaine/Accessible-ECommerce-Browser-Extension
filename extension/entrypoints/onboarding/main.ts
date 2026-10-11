import { createMic, toAsrRequest } from '@/src/audio/mic';
import { createRuntimeBackend, type BackendReply } from '@/src/core/backend';
import { createProfileStore } from '@/src/core/profile';
import { phraseAudioUrl } from '@/src/audio/phrases';
import { createPlayer } from '@/src/audio/player';
import { createSpeechSources } from '@/src/audio/sources';
import { createPlayerSpeaker } from '@/src/core/voice';
import { startOnboarding } from '@/src/ui/onboarding';

// First-run setup page, opened once by the background script on install (or from Settings).
void (async () => {
  const store = await createProfileStore();
  const backend = createRuntimeBackend(
    (message) => browser.runtime.sendMessage(message) as Promise<BackendReply>,
  );
  const mic = createMic();
  // The setup page talks through Track A's player too (rule 12), with pre-recorded prompts.
  const demo = (import.meta.env.VITE_BACKEND ?? 'mock') === 'mock';
  const sources = createSpeechSources({
    tts: (text, lang) => backend.tts({ schema_version: '1.0', text, lang }),
    lite: () => demo || store.get().prefs.lite_mode,
    phraseUrl: phraseAudioUrl,
  });
  const speaker = createPlayerSpeaker(createPlayer({ sources, rate: store.get().prefs.tts_rate }));
  startOnboarding({
    root: document.getElementById('app')!,
    store,
    onDone: () => {
      speaker.stop();
      window.close();
    },
    speak: (lines) => speaker.sayLines(lines),
    // Hold Space (or press Speak) and say the answer; letting go of Space sends it.
    listen: async ({ hold = false } = {}) => {
      speaker.stop();
      const utterance = await mic.listen({ mode: hold ? 'speech' : 'default' });
      if (!utterance.audioBase64) return null;
      const asr = await backend.asr(toAsrRequest(utterance, store.get().prefs.lang));
      return asr.text || null;
    },
    stopListening: () => mic.stop(),
  });
})();
