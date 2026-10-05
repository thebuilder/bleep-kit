/* A small in-place radix-2 FFT with a Hann window, for the 1024 point spectrum. */

export interface Spectrum {
  /** Fill `mag` (size / 2 magnitudes, 0..~1) from `samples` (size of them). */
  magnitudes(samples: Float32Array, mag: Float32Array): void;
  readonly size: number;
}

export function createSpectrum(size = 1024): Spectrum {
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  const win = new Float32Array(size);
  const rev = new Uint16Array(size);
  const cos = new Float32Array(size / 2);
  const sin = new Float32Array(size / 2);
  const bits = Math.log2(size);
  for (let i = 0; i < size; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
    let r = 0;
    for (let b = 0; b < bits; b++) {
      r |= ((i >> b) & 1) << (bits - 1 - b);
    }
    rev[i] = r;
  }
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = -Math.sin((2 * Math.PI * i) / size);
  }
  return {
    magnitudes(samples, mag) {
      for (let i = 0; i < size; i++) {
        re[rev[i] as number] = (samples[i] ?? 0) * (win[i] as number);
        im[rev[i] as number] = 0;
      }
      for (let len = 2; len <= size; len <<= 1) {
        const half = len >> 1;
        const step = size / len;
        for (let i = 0; i < size; i += len) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j;
            const b = a + half;
            const tr =
              (re[b] as number) * (cos[k] as number) -
              (im[b] as number) * (sin[k] as number);
            const ti =
              (re[b] as number) * (sin[k] as number) +
              (im[b] as number) * (cos[k] as number);
            re[b] = (re[a] as number) - tr;
            im[b] = (im[a] as number) - ti;
            re[a] = (re[a] as number) + tr;
            im[a] = (im[a] as number) + ti;
          }
        }
      }
      const norm = 4 / size;
      for (let i = 0; i < size / 2; i++) {
        mag[i] = Math.hypot(re[i] as number, im[i] as number) * norm;
      }
    },
    size,
  };
}
