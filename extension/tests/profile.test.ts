import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { defaultProfile, loadProfile, saveProfile } from '../src/core/profile';

describe('profile store', () => {
  beforeEach(() => fakeBrowser.reset());

  it('returns the default profile, then round-trips through storage.local', async () => {
    expect(await loadProfile()).toEqual(defaultProfile());
    const p = defaultProfile();
    p.prefs.lang = 'hi';
    await saveProfile(p);
    expect((await loadProfile()).prefs.lang).toBe('hi');
  });
});
