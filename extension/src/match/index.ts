// Local command matcher: the dysarthria fast path (docs/conditions.md, layer 2).
// Fuzzy-matches an utterance against playback/confirmation commands, on-screen target labels
// and product short names. Only a confident, unambiguous match acts locally (no server call);
// anything else passes to the normal turn, carrying the top candidates as hints. Never acts
// below 0.8.
//
// Scoring is word-level: each spoken word is compared with the candidate's words by edit
// distance (so "add to card" ~ "Add to Cart"), and the score is scaled by how much of the
// candidate was covered (so "cart" prefers the "Cart" link over "Add to Cart"). A short word
// inside a longer one doesn't count ("no" is not "Novix"), unlike substring-based fuzzy search.
import type { ActionTarget, ProductJSON } from '@shared/index';

export const ACT_THRESHOLD = 0.8;
/** Best must beat a different runner-up by this much, or it's ambiguous. */
export const MIN_MARGIN = 0.1;

export type CommandId =
  | 'pause'
  | 'resume'
  | 'stop'
  | 'repeat'
  | 'repeat_all'
  | 'back'
  | 'next_section'
  | 'previous_section'
  | 'slower'
  | 'faster'
  | 'yes'
  | 'no'
  | 'help'
  | 'undo';

/** English command phrases. Other languages come from src/i18n (requested from Track A). */
export const COMMANDS: Record<CommandId, string[]> = {
  // Hindi and Telugu forms from Track A's player.controls_hint.
  pause: ['pause', 'wait', 'hold on', 'रुको', 'ఆపు'],
  resume: ['resume', 'continue', 'play'],
  stop: ['stop', 'quiet', 'be quiet'],
  repeat: ['repeat', 'repeat that', 'say again', 'again', 'दोबारा', 'మళ్లీ'],
  repeat_all: ['repeat all', 'start again', 'from the start'],
  back: ['go back', 'back one', 'previous sentence'],
  next_section: ['next', 'next section', 'skip'],
  previous_section: ['previous', 'previous section'],
  slower: ['slower', 'slow down'],
  faster: ['faster', 'speed up'],
  yes: ['yes', 'yeah', 'yep', 'confirm', 'okay'],
  no: ['no', 'nope', 'cancel', "don't"],
  help: ['help', 'what can i say'],
  undo: ['undo', 'turn it off', 'switch it off'],
};

export interface Candidate {
  kind: 'command' | 'target' | 'product';
  /** CommandId, ActionTarget id or ProductJSON id. */
  id: string;
  text: string;
}

export interface Scored {
  candidate: Candidate;
  confidence: number;
}

export type MatchDecision =
  | { action: 'act'; best: Scored; alternatives: Scored[] }
  | { action: 'pass'; alternatives: Scored[] };

const FILLERS = /\b(please|can you|could you|the|a|an|it|now|um+|uh+)\b/g;

export function normalise(text: string): string {
  return (
    text
      .toLowerCase()
      // Keep marks (\p{M}): Devanagari and Telugu vowel signs are marks, not letters.
      .replace(/[^\p{L}\p{M}\p{N}\s']/gu, ' ')
      .replace(FILLERS, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function buildCandidates(
  opts: { targets?: ActionTarget[]; products?: ProductJSON[]; commands?: boolean } = {},
): Candidate[] {
  const out: Candidate[] = [];
  if (opts.commands !== false) {
    for (const [id, phrases] of Object.entries(COMMANDS)) {
      for (const text of phrases) out.push({ kind: 'command', id, text });
    }
  }
  for (const t of opts.targets ?? []) {
    if (!t.state?.disabled && t.label.trim()) out.push({ kind: 'target', id: t.id, text: t.label });
  }
  for (const p of opts.products ?? []) {
    const name = p.title ? shortName(p.title) : '';
    if (name) out.push({ kind: 'product', id: p.id, text: name });
  }
  return out;
}

/** Product short name: the first three words before any "(variant, specs)" part. */
export function shortName(title: string): string {
  return title.split('(')[0]!.trim().split(/\s+/).slice(0, 3).join(' ');
}

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const wordSim = (a: string, b: string) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);

const bestSim = (word: string, others: string[]) =>
  Math.max(0, ...others.map((o) => wordSim(word, o)));

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;

/** 0-1: how well the spoken words match, scaled by how much of the candidate they cover. */
export function score(queryWords: string[], candidateWords: string[]): number {
  if (queryWords.length === 0 || candidateWords.length === 0) return 0;
  const matched = mean(queryWords.map((q) => bestSim(q, candidateWords)));
  const covered = mean(candidateWords.map((c) => bestSim(c, queryWords)));
  return matched * (0.5 + 0.5 * covered);
}

export interface Matcher {
  match(utterance: string): MatchDecision;
}

export function createMatcher(candidates: Candidate[]): Matcher {
  const entries = candidates
    .map((candidate) => ({
      candidate,
      words: normalise(candidate.text).split(' ').filter(Boolean),
    }))
    .filter((e) => e.words.length > 0);

  return {
    match(utterance) {
      const words = normalise(utterance).split(' ').filter(Boolean);
      if (words.length === 0) return { action: 'pass', alternatives: [] };

      // Best score per distinct candidate (several phrases can map to one command).
      const best = new Map<string, Scored>();
      for (const { candidate, words: cw } of entries) {
        const confidence = score(words, cw);
        const key = `${candidate.kind}:${candidate.id}`;
        if ((best.get(key)?.confidence ?? -1) < confidence)
          best.set(key, { candidate, confidence });
      }
      const ranked = [...best.values()]
        .filter((s) => s.confidence > 0.3)
        .sort((a, b) => b.confidence - a.confidence);
      const [top, runnerUp] = ranked;
      const alternatives = ranked.slice(0, 2);
      if (
        top &&
        top.confidence >= ACT_THRESHOLD &&
        (!runnerUp || top.confidence - runnerUp.confidence >= MIN_MARGIN)
      ) {
        return { action: 'act', best: top, alternatives };
      }
      return { action: 'pass', alternatives };
    },
  };
}

/** Kept for callers of the scaffold stub: exact, case-insensitive match. */
export function matchLocal(
  utterance: string,
  candidates: readonly string[],
): { candidate: string; score: number } | null {
  const needle = utterance.trim().toLowerCase();
  const hit = candidates.find((c) => c.toLowerCase() === needle);
  return hit === undefined ? null : { candidate: hit, score: 1 };
}
