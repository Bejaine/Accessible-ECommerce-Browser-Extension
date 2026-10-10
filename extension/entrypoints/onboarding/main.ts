import { createMic, toAsrRequest } from '@/src/audio/mic';
import { createRuntimeBackend, type BackendReply } from '@/src/core/backend';
import { createProfileStore } from '@/src/core/profile';
import { createSpeaker } from '@/src/render/speaker';
import { startOnboarding } from '@/src/ui/onboarding';

// First-run setup page, opened once by the background script on install (or from Settings).
void (async () => {
  const store = await createProfileStore();
  const backend = createRuntimeBackend(
    (message) => browser.runtime.sendMessage(message) as Promise<BackendReply>,
  );
  const mic = createMic();
  const speaker = createSpeaker();
  speaker.setRate(store.get().prefs.tts_rate);
  startOnboarding({
    root: document.getElementById('app')!,
    store,
    onDone: () => {
      speaker.stop();
      window.close();
    },
    speak: (lines) => speaker.sayLines(lines),
    listen: async () => {
      speaker.stop();
      const utterance = await mic.listen();
      if (!utterance.audioBase64) return null;
      const asr = await backend.asr(toAsrRequest(utterance, store.get().prefs.lang));
      return asr.text || null;
    },
  });
})();
