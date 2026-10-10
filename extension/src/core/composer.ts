// Multi-condition composer: resolves active conditions into one ResolvedMode.
// STUB: returns the no-condition default. Rules live in docs/conditions.md.
import type { Profile, ResolvedMode } from '@shared/index';

export function resolveMode(profile: Profile): ResolvedMode {
  return {
    input_channels: ['voice', 'keyboard', 'phrase', 'switch'],
    input_rung: 'voice',
    output_channels: ['audio', 'visual'],
    tts_rate: profile.prefs.tts_rate,
    scan_interval_ms: 1500,
    max_options: 5,
    verbosity: profile.prefs.verbosity,
  };
}
