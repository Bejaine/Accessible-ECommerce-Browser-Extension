// Profile store. The profile never leaves the device (rule 8); only prefs go to the backend.
import { browser } from 'wxt/browser';
import type { Profile } from '@shared/index';

const KEY = 'profile';

export function defaultProfile(): Profile {
  const off = { score: 0, active: false, source: 'inferred' as const };
  return {
    schema_version: '1.0',
    conditions: {
      visual: { ...off },
      speech: { ...off },
      motor: { ...off },
      ageing: { ...off },
      colour: { score: 0, active: false, source: 'user' },
    },
    prefs: {
      lang: 'en',
      tts_rate: 1,
      text_scale: 1,
      verbosity: 'normal',
      lite_mode: false,
      text_first: false,
      switch_key: 'Space',
      preferred_payment: null,
    },
  };
}

export async function loadProfile(): Promise<Profile> {
  const stored = await browser.storage.local.get(KEY);
  return (stored[KEY] as Profile | undefined) ?? defaultProfile();
}

export async function saveProfile(profile: Profile): Promise<void> {
  await browser.storage.local.set({ [KEY]: profile });
}

export type ConditionName = keyof Profile['conditions'];

export interface ProfileStore {
  get(): Profile;
  /** Apply a change, persist it, and notify subscribers. */
  update(change: (draft: Profile) => void): Promise<void>;
  subscribe(listener: (profile: Profile) => void): () => void;
}

/** In-memory profile with persistence and change notification (e.g. a mode was accepted). */
export async function createProfileStore(): Promise<ProfileStore> {
  let profile = await loadProfile().catch(() => defaultProfile());
  const listeners = new Set<(p: Profile) => void>();
  return {
    get: () => profile,
    async update(change) {
      const next = structuredClone(profile);
      change(next);
      profile = next;
      listeners.forEach((l) => l(profile));
      await saveProfile(profile);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** First-run onboarding state (device only; not part of the Profile contract). */
export const ONBOARDING_KEY = 'onboarding';
/** Runtime message: ask the background script to open the setup page. */
export const OPEN_ONBOARDING = 'open-onboarding';
/** Runtime message from the keyboard shortcut: open or close the assistant in this tab. */
export const TOGGLE_ASSISTANT = 'toggle-assistant';
/** manifest `commands` name for the shortcut. */
export const ASSISTANT_COMMAND = 'toggle-assistant';
/** manifest `commands` name and runtime message for the single playback key. */
export const PLAYBACK_COMMAND = 'playback-key';

export async function isOnboarded(): Promise<boolean> {
  const stored = await browser.storage.local.get(ONBOARDING_KEY);
  return Boolean((stored[ONBOARDING_KEY] as { done?: boolean } | undefined)?.done);
}

export async function markOnboarded(): Promise<void> {
  await browser.storage.local.set({
    [ONBOARDING_KEY]: { done: true, at: new Date().toISOString() },
  });
}

/**
 * Device-only preferences outside the Profile contract. `assistantVoice` = the assistant's own
 * voice: 'auto' speaks when read-aloud or simple mode is on (users without a screen reader);
 * screen-reader users can turn it off to avoid hearing everything twice. `dwellMs` = dwell to
 * click on the assistant's own controls (null = off).
 */
export interface DevicePrefs {
  assistantVoice: 'auto' | 'on' | 'off';
  dwellMs?: number | null;
  /** Speaking while the assistant reads pauses it (barge-in). Unset: on for desktop, off on phones. */
  interruptBySpeaking?: boolean;
}

/**
 * Barge-in default: on with a desktop's echo cancellation; off on touch devices, where the phone's
 * speaker is heard by its own mic (Track A's live test). The user can change it in Settings.
 */
export function interruptBySpeaking(prefs: DevicePrefs): boolean {
  if (prefs.interruptBySpeaking !== undefined) return prefs.interruptBySpeaking;
  try {
    return !matchMedia('(pointer: coarse)').matches;
  } catch {
    return true;
  }
}

export const DEVICE_PREFS_KEY = 'device-prefs';

export async function loadDevicePrefs(): Promise<DevicePrefs> {
  const stored = await browser.storage.local.get(DEVICE_PREFS_KEY);
  return {
    assistantVoice: 'auto',
    ...(stored[DEVICE_PREFS_KEY] as Partial<DevicePrefs> | undefined),
  };
}

export async function saveDevicePrefs(prefs: DevicePrefs): Promise<void> {
  await browser.storage.local.set({ [DEVICE_PREFS_KEY]: prefs });
}

export function assistantVoiceOn(profile: Profile, prefs: DevicePrefs): boolean {
  if (prefs.assistantVoice !== 'auto') return prefs.assistantVoice === 'on';
  return profile.conditions.visual.active || profile.conditions.ageing.active;
}
