// Generates the listening cues (src/ui/cues/*.wav): short two-note chimes, rising when the
// assistant starts listening, falling when it stops. Run once: `node dev/make-cues.mjs`.
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 22050;
const NOTE_MS = 90;
const GAP_MS = 15;
const AMP = 0.28;

function note(hz) {
  const n = Math.round((RATE * NOTE_MS) / 1000);
  const out = new Float32Array(n);
  const fade = Math.round(RATE * 0.012);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - i) / fade);
    // A soft tone: fundamental plus a quiet octave.
    out[i] =
      (AMP *
        env *
        (Math.sin((2 * Math.PI * hz * i) / RATE) +
          0.25 * Math.sin((4 * Math.PI * hz * i) / RATE))) /
      1.25;
  }
  return out;
}

function chime(freqs) {
  const gap = new Float32Array(Math.round((RATE * GAP_MS) / 1000));
  const parts = freqs.flatMap((f, i) => (i ? [gap, note(f)] : [note(f)]));
  const len = parts.reduce((s, p) => s + p.length, 0);
  const all = new Float32Array(len);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return all;
}

function wav(samples) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples.length * 2, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(RATE, 24);
  bytes.writeUInt32LE(RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((s, i) =>
    bytes.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), 44 + i * 2),
  );
  return bytes;
}

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/ui/cues');
writeFileSync(resolve(dir, 'listen.wav'), wav(chime([660, 990]))); // rising: listening
writeFileSync(resolve(dir, 'done.wav'), wav(chime([990, 660]))); // falling: stopped listening
console.log('wrote', dir);
