// WAV encoding for ASR uploads (Track A). AnuvaadHub ASR takes WAV only, ~20 s, < 5 MB,
// so we send 16 kHz mono 16-bit PCM: 19 s is ~600 KB.

export const ASR_SAMPLE_RATE = 16000;

/** Downsample with a box filter (each output sample averages the input it covers), which
 *  also removes most content above the new Nyquist rate. Upsampling interpolates linearly. */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  if (ratio > 1) {
    for (let i = 0; i < out.length; i++) {
      const start = i * ratio;
      const end = Math.min(start + ratio, input.length);
      let sum = 0;
      let weight = 0;
      for (let j = Math.floor(start); j < end; j++) {
        const w = Math.min(j + 1, end) - Math.max(j, start); // partial overlap at the edges
        sum += (input[j] ?? 0) * w;
        weight += w;
      }
      out[i] = weight > 0 ? sum / weight : 0;
    }
  } else {
    for (let i = 0; i < out.length; i++) {
      const pos = i * ratio;
      const j = Math.floor(pos);
      const a = input[j] ?? 0;
      const b = input[j + 1] ?? a;
      out[i] = a + (b - a) * (pos - j);
    }
  }
  return out;
}

/** Mono 16-bit PCM WAV. Samples are clamped to [-1, 1]. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) bytes[offset + i] = s.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : Math.round(s * 0x7fff), true);
  }
  return bytes;
}

/** Base64 without blowing the call stack on large buffers (String.fromCharCode in chunks). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
