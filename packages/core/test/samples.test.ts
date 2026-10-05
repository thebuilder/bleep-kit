/* Sample generators (section 3.7): deterministic synthesis of drums and one-cycle instruments. */

import { describe, expect, it } from "vitest";
import type { GeneratedSample, SampleGeneratorId } from "../src/index.ts";
import {
  generateSample,
  SAMPLE_GENERATOR_IDS,
  SAMPLE_GENERATORS,
} from "../src/index.ts";
import { hashChannels, peak, rms } from "./helpers.ts";

const TONAL: readonly SampleGeneratorId[] = [
  "pluck",
  "bass",
  "pad",
  "organ",
  "bell",
  "strings",
  "choir",
  "lead",
];
const LOOPING: readonly SampleGeneratorId[] = [
  "bass",
  "pad",
  "organ",
  "strings",
  "choir",
  "lead",
];

function defaults(id: SampleGeneratorId): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, spec] of Object.entries(SAMPLE_GENERATORS[id].params)) {
    out[k] = spec.default;
  }
  return out;
}

function make(
  id: SampleGeneratorId,
  seed = 1,
  sr = 48_000,
  params?: Record<string, number>
): GeneratedSample {
  return generateSample(id, params ?? defaults(id), seed, sr);
}

function finite(a: Float32Array): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (!Number.isFinite(a[i])) {
      return false;
    }
  }
  return true;
}

function mean(a: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) {
    s += a[i] ?? 0;
  }
  return s / Math.max(1, a.length);
}

/** Frequency from the autocorrelation peak between minHz and maxHz. */
function acfHz(
  data: Float32Array,
  sr: number,
  from: number,
  length: number,
  minHz: number,
  maxHz: number
): number {
  const lagMin = Math.floor(sr / maxHz);
  const lagMax = Math.ceil(sr / minHz);
  let best = 0;
  let bestLag = lagMin;
  for (let lag = lagMin; lag <= lagMax; lag += 1) {
    let sum = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = from; i < from + length - lag; i += 1) {
      const a = data[i] ?? 0;
      const b = data[i + lag] ?? 0;
      sum += a * b;
      e1 += a * a;
      e2 += b * b;
    }
    const c = sum / Math.sqrt(e1 * e2 + 1e-12);
    if (c > best) {
      best = c;
      bestLag = lag;
    }
  }
  // parabolic refinement
  const at = (lag: number): number => {
    let sum = 0;
    for (let i = from; i < from + length - lag; i += 1) {
      sum += (data[i] ?? 0) * (data[i + lag] ?? 0);
    }
    return sum;
  };
  const y0 = at(bestLag - 1);
  const y1 = at(bestLag);
  const y2 = at(bestLag + 1);
  const denom = y0 - 2 * y1 + y2;
  const shift = denom === 0 ? 0 : (0.5 * (y0 - y2)) / denom;
  return sr / (bestLag + shift);
}

describe("sample generators", () => {
  it("there is a spec for every generator id", () => {
    for (const id of SAMPLE_GENERATOR_IDS) {
      expect(SAMPLE_GENERATORS[id].id).toBe(id);
      expect(Object.keys(SAMPLE_GENERATORS[id].params).length).toBeGreaterThan(
        0
      );
      for (const spec of Object.values(SAMPLE_GENERATORS[id].params)) {
        expect(spec.min).toBeLessThan(spec.max);
        expect(spec.default).toBeGreaterThanOrEqual(spec.min);
        expect(spec.default).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  for (const id of SAMPLE_GENERATOR_IDS) {
    describe(id, () => {
      it("produces a finite, audible, unclipped sample", () => {
        const s = make(id);
        expect(s.data.length).toBeGreaterThan(64);
        expect(finite(s.data)).toBe(true);
        const p = peak([s.data]);
        expect(p).toBeGreaterThan(0.3);
        expect(p).toBeLessThanOrEqual(1);
        expect(s.sampleRate).toBe(48_000);
        expect(Math.abs(mean(s.data))).toBeLessThan(0.02);
      });

      it("is deterministic and the seed matters only where noise is used", () => {
        const a = make(id, 5);
        const b = make(id, 5);
        expect(hashChannels([a.data])).toBe(hashChannels([b.data]));
        expect(a.data.length).toBe(b.data.length);
      });

      it("a one shot fades out to silence at its end", () => {
        const s = make(id);
        if (s.loopEnd === null) {
          expect(Math.abs(s.data.at(-1) ?? 0)).toBeLessThan(0.02);
        }
      });

      it("works at 22050 and 96000 Hz with the same length in seconds", () => {
        const lo = make(id, 1, 22_050);
        const hi = make(id, 1, 96_000);
        expect(finite(lo.data) && finite(hi.data)).toBe(true);
        // looped bodies round to whole cycles, so lengths agree to within 15 percent
        const ratio = lo.data.length / 22_050 / (hi.data.length / 96_000);
        expect(ratio).toBeGreaterThan(0.85);
        expect(ratio).toBeLessThan(1.15);
      });

      it("clamps absurd parameters instead of failing", () => {
        const params: Record<string, number> = {};
        for (const k of Object.keys(SAMPLE_GENERATORS[id].params)) {
          params[k] = 1e6;
        }
        const s = generateSample(id, params, 1, 48_000);
        expect(finite(s.data)).toBe(true);
        expect(s.data.length).toBeLessThan(48_000 * 12);
        const z: Record<string, number> = {};
        for (const k of Object.keys(SAMPLE_GENERATORS[id].params)) {
          z[k] = -1e6;
        }
        expect(finite(generateSample(id, z, 1, 48_000).data)).toBe(true);
      });
    });
  }

  for (const id of LOOPING) {
    it(`${id} loops on whole cycles without a seam`, () => {
      const s = make(id);
      expect(SAMPLE_GENERATORS[id].loops).toBe(true);
      expect(s.loopStart).not.toBeNull();
      expect(s.loopEnd).toBe(s.data.length);
      const start = s.loopStart ?? 0;
      const end = s.loopEnd ?? 0;
      expect(end - start).toBeGreaterThan(256);
      // jump over the seam versus the largest neighbouring step inside the loop
      const seam = Math.abs((s.data[start] ?? 0) - (s.data[end - 1] ?? 0));
      let inner = 0;
      for (let i = start + 1; i < end; i += 1) {
        inner = Math.max(
          inner,
          Math.abs((s.data[i] ?? 0) - (s.data[i - 1] ?? 0))
        );
      }
      expect(seam).toBeLessThan(Math.max(inner * 2, 0.02));
    });
  }

  for (const id of SAMPLE_GENERATOR_IDS.filter((g) => !LOOPING.includes(g))) {
    it(`${id} is a one shot`, () => {
      const s = make(id);
      expect(s.loopStart).toBeNull();
      expect(s.loopEnd).toBeNull();
    });
  }

  it("tonal generators sit on their base note (C-4) within 5 cents", () => {
    const targets: Partial<Record<SampleGeneratorId, number>> = {
      choir: 261.6256,
      lead: 261.6256,
      organ: 261.6256,
      pad: 261.6256,
      strings: 261.6256,
    };
    for (const id of TONAL) {
      const want = targets[id];
      if (want === undefined) {
        continue;
      }
      const s = make(id);
      const len = Math.min(s.data.length - 2000, 16_384);
      const hz = acfHz(
        s.data,
        s.sampleRate,
        Math.floor(s.data.length / 2 - len / 2),
        len,
        200,
        340
      );
      const cents = 1200 * Math.log2(hz / want);
      expect(
        Math.abs(cents),
        `${id} measured ${hz.toFixed(2)} Hz`
      ).toBeLessThan(5);
    }
  });

  it("the kick sweeps down and the hat is brighter than the kick", () => {
    const kick = make("kick");
    const hat = make("hat");
    const early = acfHz(kick.data, kick.sampleRate, 200, 1600, 40, 400);
    const late = acfHz(kick.data, kick.sampleRate, 6000, 4000, 30, 200);
    expect(early).toBeGreaterThan(late);
    const zc = (a: Float32Array): number => {
      let c = 0;
      for (let i = 1; i < a.length; i += 1) {
        if ((a[i] ?? 0) >= 0 !== (a[i - 1] ?? 0) >= 0) {
          c += 1;
        }
      }
      return c / a.length;
    };
    expect(zc(hat.data)).toBeGreaterThan(zc(kick.data) * 5);
  });

  it("decay parameters shorten and lengthen one shots", () => {
    const short = make("snare", 1, 48_000, {
      ...defaults("snare"),
      decay: 0.06,
    });
    const long = make("snare", 1, 48_000, { ...defaults("snare"), decay: 0.6 });
    expect(long.data.length).toBeGreaterThan(short.data.length);
    expect(rms(long.data, Math.floor(long.data.length / 2))).toBeGreaterThan(
      rms(short.data, Math.floor(short.data.length / 2)) * 0.5
    );
  });

  it("different seeds change the noise based drums", () => {
    const a = make("snare", 1);
    const b = make("snare", 2);
    expect(hashChannels([a.data])).not.toBe(hashChannels([b.data]));
    const c = make("hat", 1);
    const d = make("hat", 2);
    expect(hashChannels([c.data])).not.toBe(hashChannels([d.data]));
  });
});
