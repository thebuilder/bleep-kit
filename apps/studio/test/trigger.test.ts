/* The scope trigger and the spectrum maths: a held note must give the same picture whatever the window start, and the
   spectrum's bands, scale and ballistics must not pin every bar to the top. */
import { describe, expect, it } from "vitest";
import {
  ATTACK_S,
  bandEdgesHz,
  bandLevels,
  createBallistics,
  DB_FLOOR,
  dbFraction,
  PEAK_HOLD_MS,
  RELEASE_DB_S,
  stepBallistics,
} from "../src/visuals/bands.ts";
import { createSpectrum } from "../src/visuals/fft.ts";
import {
  createTrigger,
  findTrigger,
  locate,
  refineLag,
  scopeTraceAt,
  searchPeriod,
} from "../src/visuals/trigger.ts";

const SR = 48_000;

function wave(
  kind: "triangle" | "pulse" | "sine",
  hz: number,
  from: number,
  n: number
): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const ph = (((from + i) * hz) / SR) % 1;
    if (kind === "triangle") {
      out[i] = (ph < 0.5 ? ph * 4 - 1 : 3 - ph * 4) * 0.6;
    } else if (kind === "pulse") {
      out[i] = ph < 0.125 ? 0.5 : -0.5;
    } else {
      out[i] = Math.sin(2 * Math.PI * ph) * 0.5;
    }
  }
  return out;
}

/** Where (modulo the period) a trigger found at buffer index `t` sits on the wave that started at `from`. */
const phaseOf = (t: number, from: number, period: number) =>
  (((t + from) % period) + period) % period;
const wrapDiff = (a: number, b: number, period: number) => {
  const d = Math.abs(a - b) % period;
  return Math.min(d, period - d);
};

describe("period finding", () => {
  it("finds the period of every kind of wave, with and without a hint", () => {
    for (const kind of ["triangle", "pulse", "sine"] as const) {
      for (const hz of [110, 440, 1760]) {
        const x = wave(kind, hz, 0, 1536);
        const period = SR / hz;
        expect(searchPeriod(x).lag).toBeCloseTo(period, 0);
        expect(
          Math.abs(refineLag(x, period + 1.2, 2).lag - period)
        ).toBeLessThan(0.5);
        // the engine's note frequency is taken as the period when the wave confirms it
        const r = locate(createTrigger(), x, 0, {
          hintHz: hz,
          sampleRate: SR,
          targetSpan: 900,
        });
        expect(r.period).toBe(period);
      }
    }
  });

  it("finds nothing in silence", () => {
    expect(searchPeriod(new Float32Array(1536)).lag).toBe(0);
  });
});

describe("trigger", () => {
  it("returns the same phase for a shifted periodic signal", () => {
    for (const kind of ["triangle", "pulse", "sine"] as const) {
      const hz = 110;
      const period = SR / hz;
      const span = 2 * period;
      const ref = findTrigger(wave(kind, hz, 0, 1536), period, span);
      expect(ref).toBeGreaterThanOrEqual(0);
      const base = phaseOf(ref, 0, period);
      for (const shift of [1, 7, 133, 400, 911, 2500]) {
        const t = findTrigger(wave(kind, hz, shift, 1536), period, span);
        // a sharp edge falls between two samples, so its linear crossing may be off by about one sample
        expect(wrapDiff(phaseOf(t, shift, period), base, period)).toBeLessThan(
          kind === "pulse" ? 1 : 0.3
        );
      }
    }
  });

  it("keeps the phase from one frame to the next and shows whole periods", () => {
    const tr = createTrigger();
    const hz = 220;
    const period = SR / hz;
    let phase = -1;
    for (let frame = 0; frame < 40; frame += 1) {
      const base = 5000 + frame * 803;
      const r = locate(tr, wave("triangle", hz, base, 1536), base, {
        hintHz: hz,
        sampleRate: SR,
        targetSpan: 900,
      });
      expect(r.span / period).toBeCloseTo(Math.round(r.span / period), 1);
      expect(r.span).toBeLessThanOrEqual(1536);
      const p = phaseOf(r.start + base, 0, period);
      if (phase >= 0) {
        expect(wrapDiff(p, phase, period)).toBeLessThan(0.3);
      }
      phase = p;
    }
  });

  it("draws the same trace for a held low note whatever the frame", () => {
    const hz = 110;
    const traces: string[] = [];
    const tr = createTrigger();
    for (const base of [10_000, 10_811, 11_977, 13_100]) {
      const x = wave("triangle", hz, base, 1536);
      const r = locate(tr, x, base, { sampleRate: SR, targetSpan: 900 });
      expect(r.period).toBeCloseTo(SR / hz, 0);
      const { spans } = scopeTraceAt(x, r.start, r.span, 96, 32);
      traces.push(Array.from(spans).join(","));
    }
    const first = (traces[0] as string).split(",").map(Number);
    for (const t of traces) {
      const cur = t.split(",").map(Number);
      const worst = cur.reduce(
        (m, v, i) => Math.max(m, Math.abs(v - (first[i] as number))),
        0
      );
      expect(worst).toBeLessThanOrEqual(1);
    }
  });

  it("does not move when there is no period (noise) or no sound", () => {
    const tr = createTrigger();
    const quiet = locate(tr, new Float32Array(1536), 0, {
      sampleRate: SR,
      targetSpan: 900,
    });
    expect(quiet).toMatchObject({ period: 0, start: 0 });
    let seed = 7;
    const noise = new Float32Array(1536).map(() => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648 - 0.5;
    });
    const r = locate(tr, noise, 0, { sampleRate: SR, targetSpan: 900 });
    expect(r.start).toBeGreaterThanOrEqual(0);
    expect(r.start + r.span).toBeLessThanOrEqual(1536);
  });
});

describe("spectrum bands", () => {
  it("spaces the bands logarithmically from 40 Hz to 16 kHz", () => {
    const e = bandEdgesHz(64, SR);
    expect(e).toHaveLength(65);
    expect(e[0]).toBeCloseTo(40, 3);
    expect(e[64]).toBeCloseTo(16_000, 0);
    const r = (e[1] as number) / (e[0] as number);
    expect((e[33] as number) / (e[32] as number)).toBeCloseTo(r, 6);
    expect(bandEdgesHz(64, 22_050)[64]).toBeLessThan(11_025);
  });

  it("puts a tone in its own band at its own level, and leaves the rest low", () => {
    const size = 1024;
    const x = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      x[i] = 0.25 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    }
    const mag = new Float32Array(size / 2);
    createSpectrum(size).magnitudes(x, mag);
    const e = bandEdgesHz(64, SR);
    const out = new Float32Array(64);
    bandLevels(mag, SR, e, out);
    let top = 0;
    for (let b = 1; b < 64; b += 1) {
      if ((out[b] as number) > (out[top] as number)) {
        top = b;
      }
    }
    expect(e[top]).toBeLessThanOrEqual(1100);
    expect(e[top + 1]).toBeGreaterThanOrEqual(900);
    // 0.25 is -12 dBFS
    expect(out[top]).toBeGreaterThan(-15);
    expect(out[top]).toBeLessThan(-9);
    const far = [...out].filter((_, b) => Math.abs(b - top) > 6);
    expect(Math.max(...far)).toBeLessThan(-40);
  });

  it("reads silence as the floor and maps dB onto a fixed scale", () => {
    const out = new Float32Array(64);
    bandLevels(new Float32Array(512), SR, bandEdgesHz(64, SR), out);
    expect(Math.max(...out)).toBe(DB_FLOOR);
    expect(dbFraction(DB_FLOOR)).toBe(0);
    expect(dbFraction(0)).toBe(1);
    expect(dbFraction(-36)).toBeCloseTo(0.5, 6);
    expect(dbFraction(20)).toBe(1);
  });
});

describe("spectrum ballistics", () => {
  it("rises fast and releases at a calm rate", () => {
    const s = createBallistics(1);
    const hit = new Float32Array([-6]);
    stepBallistics(s, hit, 0.05, 50);
    expect(s.bars[0]).toBeGreaterThan(
      -6 - 66 * Math.exp(-0.05 / ATTACK_S) - 0.5
    );
    const quiet = new Float32Array([DB_FLOOR]);
    const top = s.bars[0] as number;
    stepBallistics(s, quiet, 0.5, 100);
    expect(top - (s.bars[0] as number)).toBeCloseTo(RELEASE_DB_S * 0.5, 3);
  });

  it("holds the peak, then lets it fall slowly", () => {
    const s = createBallistics(1);
    const hit = new Float32Array([-6]);
    for (let t = 0; t < 10; t += 1) {
      stepBallistics(s, hit, 0.016, t * 16);
    }
    const peak = s.peaks[0] as number;
    const quiet = new Float32Array([DB_FLOOR]);
    let now = 160;
    while (now < 160 + PEAK_HOLD_MS - 50) {
      now += 16;
      stepBallistics(s, quiet, 0.016, now);
    }
    expect(s.peaks[0]).toBe(peak);
    expect(s.bars[0]).toBeLessThan(peak);
    for (let k = 0; k < 30; k += 1) {
      now += 16;
      stepBallistics(s, quiet, 0.016, now);
    }
    expect(s.peaks[0]).toBeLessThan(peak);
    expect(s.peaks[0]).toBeGreaterThan(peak - 8);
  });
});
