// AccessibleOutput -> spoken sections for the audio player (src/audio/player.ts).
// The summary is always first; warnings follow it so they are never skipped. Each section is
// a unit for "next/previous section". Sentence splitting is the player's job.
import type { AccessibleOutput, Section, Verbosity } from '@shared/index';

export interface SpokenSection {
  id: string;
  heading: string | null;
  lines: string[];
}

export interface SpeechOptions {
  /** Use the plain-language versions where the backend provided them. */
  simpler?: boolean;
  /** `short` speaks only the summary and warnings; sections stay available on request. */
  verbosity?: Verbosity;
}

/** True if the backend sent any plain-language text ("explain simpler" is possible). */
export function canSimplify(output: AccessibleOutput): boolean {
  return output.simpler !== null || output.sections.some((s) => s.simpler !== null);
}

function sectionLines(section: Section, simpler: boolean): string[] {
  if (simpler && section.simpler !== null) return [section.simpler];
  const lines = section.items.map((item) => item.text);
  if (section.table) lines.push(section.table.spoken);
  return lines;
}

export function toSpokenSections(
  output: AccessibleOutput,
  { simpler = false, verbosity = 'normal' }: SpeechOptions = {},
): SpokenSection[] {
  const summary = simpler && output.simpler !== null ? output.simpler : output.summary;
  const spoken: SpokenSection[] = [
    { id: 'summary', heading: null, lines: [summary, ...output.warnings] },
  ];
  if (verbosity === 'short') return spoken;
  output.sections.forEach((section, i) => {
    const lines = sectionLines(section, simpler);
    if (lines.length > 0) spoken.push({ id: `section-${i}`, heading: section.heading, lines });
  });
  return spoken;
}

/** Flat line list (headings included) for players that don't know about sections yet. */
export function flattenSpoken(sections: SpokenSection[]): string[] {
  return sections.flatMap((s) => (s.heading === null ? s.lines : [s.heading, ...s.lines]));
}
