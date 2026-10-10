// Synthetic audio for the audio tests: deterministic, no microphone needed.

/** A sine tone, loud enough to count as speech. */
export function tone(seconds: number, rate: number, amp = 0.3, hz = 220): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Low random noise, like a quiet room. Seeded so every run is identical. */
export function hiss(seconds: number, rate: number, amp = 0.001, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  let s = seed;
  for (let i = 0; i < out.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = amp * ((s / 2 ** 32) * 2 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Split audio into chunks the way ScriptProcessorNode delivers it. */
export function chunks(audio: Float32Array, size = 2048): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < audio.length; i += size) out.push(audio.subarray(i, i + size));
  return out;
}

/** Parse the fields of a PCM WAV we care about. */
export function readWav(bytes: Uint8Array) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  return {
    riff: text(0),
    wave: text(8),
    format: v.getUint16(20, true),
    channels: v.getUint16(22, true),
    sampleRate: v.getUint32(24, true),
    bits: v.getUint16(34, true),
    dataBytes: v.getUint32(40, true),
    sample: (i: number) => v.getInt16(44 + 2 * i, true),
    seconds: v.getUint32(40, true) / 2 / v.getUint32(24, true),
  };
}
