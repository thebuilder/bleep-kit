import { describe, expect, it } from "vitest";
import { fft, hann, spectrogram } from "../../src/tools/spectrum.ts";
import { sine } from "./helpers.ts";

describe("fft", () => {
  it("puts a bin centered sine in one bin with the right magnitude", () => {
    const n = 1024;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      re[i] = Math.cos((2 * Math.PI * 37 * i) / n);
    }
    fft(re, im);
    expect(re[37]).toBeCloseTo(n / 2, 6);
    expect(re[n - 37]).toBeCloseTo(n / 2, 6);
    let other = 0;
    for (let k = 0; k < n; k += 1) {
      if (k !== 37 && k !== n - 37) {
        other = Math.max(other, Math.hypot(re[k] ?? 0, im[k] ?? 0));
      }
    }
    expect(other).toBeLessThan(1e-9);
  });

  it("agrees with a direct DFT on a short signal", () => {
    const n = 16;
    const x = Float64Array.from(
      { length: n },
      (_, i) => Math.sin(i * 1.3) + 0.5 * (i % 3)
    );
    const re = Float64Array.from(x);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k += 1) {
      let dr = 0;
      let di = 0;
      for (let t = 0; t < n; t += 1) {
        dr += (x[t] ?? 0) * Math.cos((2 * Math.PI * k * t) / n);
        di -= (x[t] ?? 0) * Math.sin((2 * Math.PI * k * t) / n);
      }
      expect(re[k]).toBeCloseTo(dr, 9);
      expect(im[k]).toBeCloseTo(di, 9);
    }
  });

  it("works on Float32Array and keeps Parseval's identity", () => {
    const n = 256;
    const re = Float32Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.9) * 0.5
    );
    const im = new Float32Array(n);
    let timeEnergy = 0;
    for (const v of re) {
      timeEnergy += v * v;
    }
    fft(re, im);
    let freqEnergy = 0;
    for (let k = 0; k < n; k += 1) {
      freqEnergy += (re[k] ?? 0) ** 2 + (im[k] ?? 0) ** 2;
    }
    expect(freqEnergy / n).toBeCloseTo(timeEnergy, 3);
  });

  it("rejects sizes that are not a power of two", () => {
    expect(() => fft(new Float64Array(100), new Float64Array(100))).toThrow(
      "power-of-two"
    );
    expect(() => fft(new Float64Array(8), new Float64Array(4))).toThrow(
      "power-of-two"
    );
  });
});

describe("hann", () => {
  it("is zero at the start, one in the middle and sums to n / 2", () => {
    const w = hann(1024);
    expect(w[0]).toBe(0);
    expect(w[512]).toBeCloseTo(1, 12);
    let sum = 0;
    for (const v of w) {
      sum += v;
    }
    expect(sum).toBeCloseTo(512, 3);
  });
});

describe("spectrogram", () => {
  it("reads a bin centered full scale sine as 0 dB at its bin", () => {
    const sr = 48_000;
    const hz = (64 * sr) / 1024; // exactly bin 64
    const spec = spectrogram(sine(sr, 0.5, hz, 1), sr);
    expect(spec.bins).toBe(513);
    expect(spec.size).toBe(1024);
    expect(spec.binHz).toBeCloseTo(sr / 1024, 9);
    const frame = 10;
    const peak = spec.db[frame * spec.bins + 64] ?? -999;
    expect(peak).toBeGreaterThan(-0.3);
    expect(peak).toBeLessThan(0.3);
    // well away from the tone the Hann window leaves almost nothing
    expect(spec.db[frame * spec.bins + 200]).toBeLessThan(-90);
  });

  it("scales with level: half amplitude reads -6 dB", () => {
    const sr = 44_100;
    const hz = (100 * sr) / 1024;
    const spec = spectrogram(sine(sr, 0.3, hz, 0.5), sr);
    expect(spec.db[5 * spec.bins + 100]).toBeCloseTo(-6.02, 1);
  });

  it("counts frames from size and hop and honors options", () => {
    const spec = spectrogram(new Float32Array(10_000), 48_000, {
      hop: 512,
      size: 2048,
    });
    expect(spec.size).toBe(2048);
    expect(spec.hop).toBe(512);
    expect(spec.bins).toBe(1025);
    expect(spec.binHz).toBeCloseTo(23.4375, 9);
    // frames start at 0, 512, ... and must fit 2048 samples inside 10000: the last starts at 7680 (ends at 9728)
    expect(spec.frames).toBe(16);
    expect(spec.db.length).toBe(16 * 1025);
    expect(spec.db[0]).toBe(-120);
  });

  it("puts a burst in the frames that cover it: frame i starts at i * hop", () => {
    const sr = 48_000;
    const hz = (64 * sr) / 1024;
    const signal = new Float32Array(8192);
    for (let i = 4096; i < signal.length; i += 1) {
      signal[i] = Math.sin((2 * Math.PI * hz * i) / sr);
    }
    const spec = spectrogram(signal, sr);
    const at = (frame: number) => spec.db[frame * spec.bins + 64] ?? Number.NaN;
    // frames 11 and 12 end at or before sample 4096: digital silence
    expect(at(11)).toBe(-120);
    expect(at(12)).toBe(-120);
    // frame 14 starts at 3584, so the burst fills the second half of its Hann window, which holds half the window's sum: -6.02 dB
    expect(at(14)).toBeCloseTo(-6.02, 1);
    // frame 16 starts at 4096 and is full of tone
    expect(at(16)).toBeCloseTo(0, 1);
    expect(at(28)).toBeCloseTo(0, 1);
  });

  it("zero pads a signal shorter than the window into one frame that holds its energy", () => {
    const sr = 48_000;
    const short = Float32Array.from({ length: 100 }, (_, i) =>
      Math.sin((2 * Math.PI * 1000 * i) / sr)
    );
    const spec = spectrogram(short, sr);
    expect(spec.frames).toBe(1);
    expect(Math.max(...spec.db)).toBeGreaterThan(-60);
    expect(spectrogram(new Float32Array(100), sr).frames).toBe(1);
  });
});
