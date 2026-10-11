// "Resume where it stopped" after a page change (docs/conditions.md, audio playback controls).
// A full navigation ends the content script and its player, so while an answer plays its
// position is kept in browser.storage.local (on the device, extension-only; never sent anywhere)
// and cleared when playback ends or is stopped. The next page of the same site offers to resume
// it if it is recent; nothing plays until the user asks (autoplay rules, and it is their choice).
import type { PlayerSnapshot } from '../audio/player';

export const RESUME_KEY = 'resume-playback';
/** Only a page reached shortly after the answer stopped gets the offer. */
export const RESUME_MAX_AGE_MS = 2 * 60_000;

export interface SavedPlayback {
  snap: PlayerSnapshot;
  site: string;
  saved_at: number;
}

export interface ResumeStore {
  save(snap: PlayerSnapshot): void;
  clear(): void;
  /** The saved position for this site, if recent; removes it either way. */
  take(): Promise<PlayerSnapshot | null>;
}

export function createResumeStore(
  site: string,
  now: () => number = Date.now,
  storage = browser.storage.local,
): ResumeStore {
  let saved = false;
  const quiet = (p: Promise<unknown>) => void p.catch(() => undefined);
  return {
    save(snap) {
      saved = true;
      const value: SavedPlayback = { snap, site, saved_at: now() };
      quiet(storage.set({ [RESUME_KEY]: value }));
    },
    clear() {
      if (!saved) return;
      saved = false;
      quiet(storage.remove(RESUME_KEY));
    },
    async take() {
      try {
        const stored = (await storage.get(RESUME_KEY))[RESUME_KEY] as SavedPlayback | undefined;
        if (!stored) return null;
        await storage.remove(RESUME_KEY);
        const fresh = now() - stored.saved_at <= RESUME_MAX_AGE_MS;
        return fresh && stored.site === site && stored.snap.sections.length > 0
          ? stored.snap
          : null;
      } catch {
        return null;
      }
    },
  };
}
