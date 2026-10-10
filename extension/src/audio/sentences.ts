// Sentence splitting for speech (Track A). The player speaks, highlights and repeats one
// segment at a time; docs/conditions.md: group short sentences so each TTS call carries one
// or two.

// A full stop does not end a sentence after these ("Rs. 1,299", "e.g. USB-C", "No. 5").
const ABBREVIATIONS = new Set(['rs', 'no', 'e.g', 'i.e', 'vs', 'mr', 'mrs', 'dr', 'approx', 'etc']);
const END = /[.!?।॥]+(?=\s|$)/g;
const MIN_SEGMENT_WORDS = 3;

export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const line of text.split(/\n+/)) {
    let start = 0;
    for (const m of line.matchAll(END)) {
      const end = (m.index ?? 0) + m[0].length;
      if (!endsSentence(line, m.index ?? 0, m[0])) continue;
      push(sentences, line.slice(start, end));
      start = end;
    }
    push(sentences, line.slice(start));
  }
  return sentences;
}

/** Sentences, with any of fewer than three words joined to the next ("Yes. Added to cart."). */
export function speechSegments(text: string): string[] {
  const segments: string[] = [];
  let pending = '';
  for (const sentence of splitSentences(text)) {
    pending = pending ? `${pending} ${sentence}` : sentence;
    if (pending.split(/\s+/).length >= MIN_SEGMENT_WORDS) {
      segments.push(pending);
      pending = '';
    }
  }
  if (pending) segments.push(pending);
  return segments;
}

function endsSentence(line: string, at: number, mark: string): boolean {
  if (mark !== '.') return !mark.startsWith('...'); // "Wait... it is fine." continues
  const word = /(\S+)$/.exec(line.slice(0, at))?.[1]?.toLowerCase() ?? '';
  if (ABBREVIATIONS.has(word)) return false;
  return !/^\s+\d/.test(line.slice(at + 1)); // "Rs. 1,299", "No. 5"
}

function push(out: string[], piece: string): void {
  const trimmed = piece.trim();
  if (trimmed) out.push(trimmed);
}
