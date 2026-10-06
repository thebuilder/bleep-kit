/* Sample generators (section 3.7): deterministic synthesis of drums and one-cycle instruments. */

import { describe, expect, it } from "vitest";
import type { GeneratedSample, SampleGeneratorId } from "../src/index.ts";
import {
  generateSample,
  SAMPLE_GENERATOR_IDS,
  SAMPLE_GENERATORS,
} from "../src/index.ts";
import { hashChannels, peak, rms } from "./helpers.ts";

/* Section 3.7: six drums, then the tonal generators; the ones with loop points are the sustained instruments. */
const DRUMS: readonly SampleGeneratorId[] = [
  "kick",
  "snare",
  "hat",
  "tom",
  "clap",
  "crash",
];
/* Pitched generators with a definite fundamental at C-4. Bell is an inharmonic FM tone (ratio 3.5), so it has no
   fundamental to measure and is left out. */
const PITCHED: readonly SampleGeneratorId[] = [
  "pluck",
  "bass",
  "pad",
  "organ",
  "strings",
  "choir",
  "lead",
];
/* Generators whose output depends on the seed because they draw noise (the studio's "Regenerate with a new seed"). */
const NOISY: readonly SampleGeneratorId[] = [
  "kick",
  "snare",
  "hat",
  "clap",
  "crash",
  "pluck",
  "choir",
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

/** Parameters of a generator whose spec minimum and maximum render the same samples: they are not wired up. */
function deadParams(id: SampleGeneratorId): string[] {
  const spec = SAMPLE_GENERATORS[id].params;
  return Object.keys(spec).filter((key) => {
    const at = (v: number) =>
      hashChannels([
        generateSample(id, { ...defaults(id), [key]: v }, 1, 48_000).data,
      ]);
    return at(spec[key]?.min ?? 0) === at(spec[key]?.max ?? 1);
  });
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
  it("the generators are the six drums and eight tonal instruments of the contract", () => {
    const documented = [
      ...DRUMS,
      "pluck",
      "bass",
      "pad",
      "organ",
      "bell",
      "strings",
      "choir",
      "lead",
    ];
    expect([...SAMPLE_GENERATOR_IDS].sort()).toEqual([...documented].sort());
    expect(Object.keys(SAMPLE_GENERATORS).sort()).toEqual(
      [...documented].sort()
    );
  });

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

      it("is deterministic: the same patch and seed give the same samples", () => {
        const a = make(id, 5);
        const b = make(id, 5);
        expect(a.data.length).toBe(b.data.length);
        expect(hashChannels([a.data])).toBe(hashChannels([b.data]));
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

      it("clamps parameters to the spec: absurd values sound like the nearest end", () => {
        const ends = (pick: (spec: { min: number; max: number }) => number) => {
          const out: Record<string, number> = {};
          for (const [k, spec] of Object.entries(
            SAMPLE_GENERATORS[id].params
          )) {
            out[k] = pick(spec);
          }
          return out;
        };
        const sample = (params: Record<string, number>) =>
          hashChannels([generateSample(id, params, 1, 48_000).data]);
        expect(sample(ends(() => 1e6))).toBe(sample(ends((p) => p.max)));
        expect(sample(ends(() => -1e6))).toBe(sample(ends((p) => p.min)));
      });

      it("never makes a sample longer than 4 seconds, whatever the parameters", () => {
        const longest: Record<string, number> = {};
        for (const [k, spec] of Object.entries(SAMPLE_GENERATORS[id].params)) {
          longest[k] = spec.max;
        }
        for (const sr of [32_000, 48_000, 96_000]) {
          const s = generateSample(id, longest, 1, sr);
          expect(s.data.length).toBeLessThanOrEqual(4 * sr);
        }
      });

      it("every declared parameter changes the sound", () => {
        expect(deadParams(id)).toEqual([]);
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
      expect(SAMPLE_GENERATORS[id].loops).toBe(false);
      expect(s.loopStart).toBeNull();
      expect(s.loopEnd).toBeNull();
    });
  }

  it("pitched generators sit on their base note C-4 within 5 cents, at the snes rate and the host rates", () => {
    const c4 = 261.6256;
    for (const sr of [32_000, 48_000]) {
      for (const id of PITCHED) {
        const s = make(id, 1, sr);
        expect(s.baseNote, id).toBe(60);
        // a plucked string has to ring: measure it after the first 50 ms, the others from the middle of the body
        const from =
          id === "pluck"
            ? Math.floor(0.05 * sr)
            : Math.floor(s.data.length / 2 - 4096);
        const hz = acfHz(s.data, sr, from, 8192, 200, 340);
        const cents = 1200 * Math.log2(hz / c4);
        expect(
          Math.abs(cents),
          `${id} at ${sr} measured ${hz.toFixed(2)} Hz`
        ).toBeLessThan(5);
      }
    }
  });

  it("drums are normalized to a 0.95 peak", () => {
    for (const id of DRUMS) {
      expect(peak([make(id).data]), id).toBeCloseTo(0.95, 3);
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

  it("the decay parameter sets how long a one shot rings", () => {
    const withDecay = (
      Object.keys(SAMPLE_GENERATORS) as SampleGeneratorId[]
    ).filter((id) => "decay" in SAMPLE_GENERATORS[id].params);
    // the drums, the crash and the bell
    expect(withDecay.sort()).toEqual([
      "bell",
      "clap",
      "crash",
      "hat",
      "kick",
      "snare",
      "tom",
    ]);
    for (const id of withDecay) {
      const spec = SAMPLE_GENERATORS[id].params.decay;
      const at = (decay: number) =>
        make(id, 1, 48_000, { ...defaults(id), decay });
      const short = at(spec?.min ?? 0);
      const long = at(spec?.max ?? 1);
      expect(long.data.length, id).toBeGreaterThan(short.data.length);
      // between 0.2 and 0.3 s the shortest decay has died away and the longest still rings
      const window = (x: GeneratedSample) => rms(x.data, 9600, 14_400);
      expect(window(long), id).toBeGreaterThan(window(short) * 10 + 0.01);
    }
  });

  it("a different seed gives different samples for every generator that draws noise", () => {
    for (const id of NOISY) {
      expect(hashChannels([make(id, 1).data]), id).not.toBe(
        hashChannels([make(id, 2).data])
      );
    }
  });

  it("every declared parameter of lead and choir changes the sound", () => {
    expect(deadParams("lead")).toEqual([]);
    expect(deadParams("choir")).toEqual([]);
  });
});
