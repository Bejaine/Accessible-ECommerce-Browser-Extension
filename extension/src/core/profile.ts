// Profile store. The profile never leaves the device (rule 8); only prefs go to the backend.
import { browser } from 'wxt/browser';
import type { Profile } from '@shared/index';

const KEY = 'profile';

export function defaultProfile(): Profile {
  const off = { score: 0, active: false, source: 'inferred' as const };
  return {
    conditions: {
      visual: { ...off },
      speech: { ...off },
      motor: { ...off },
      ageing: { ...off },
      colour: { score: 0, active: false, source: 'user' },
    },
    prefs: { lang: 'en', tts_rate: 1, text_scale: 1, verbosity: 'normal', lite_mode: false },
  };
}

export async function loadProfile(): Promise<Profile> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as Profile | undefined) ?? defaultProfile();
}

export async function saveProfile(profile: Profile): Promise<void> {
  await browser.storage.local.set({ [KEY]: profile });
}
