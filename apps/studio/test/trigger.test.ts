// @vitest-environment node
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
  PEAK_FALL_DB_S,
  PEAK_HOLD_MS,
  RELEASE_DB_S,
  SILENT_PEAK,
  STOP_FALL_DB_S,
  stepBallistics,
} from "../src/visuals/bands.ts";
import { createSpectrum } from "../src/visuals/fft.ts";
import {
  columnHeights,
  createLevelState,
  createMode,
  createTexture,
  LEVEL_ENTER_FRAMES,
  LEVEL_FLOOR_DB,
  LEVEL_LEAVE_FRAMES,
  levelDb,
  levelMode,
  updateLevel,
} from "../src/visuals/level.ts";
import {
  createTrigger,
  findTrigger,
  locate,
  MAX_WINDOW,
  MIN_WINDOW,
  refineLag,
  scopeTraceAt,
  scopeWindowFrames,
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

describe("low notes", () => {
  it("sizes the window for two periods of the note, between 1536 and 4096 frames", () => {
    expect(scopeWindowFrames(0)).toBe(MIN_WINDOW);
    expect(scopeWindowFrames(SR / 440)).toBe(MIN_WINDOW);
    // 55 Hz: 873 frames a period
    expect(scopeWindowFrames(SR / 55)).toBe(2304);
    // 27.5 Hz, the lowest note the chips play: 1745 frames a period, two of them fit with margin
    const low = scopeWindowFrames(SR / 27.5);
    expect(low).toBe(MAX_WINDOW);
    expect(low).toBeGreaterThanOrEqual(2 * (SR / 27.5) + 256);
    expect(scopeWindowFrames(SR / 10)).toBe(MAX_WINDOW);
  });

  it("locks to a 30 Hz triangle in the ring and draws the same trace every frame", () => {
    for (const hz of [30, 27.5, 41.2]) {
      const period = SR / hz;
      const window = scopeWindowFrames(period);
      const tr = createTrigger();
      let first: number[] | null = null;
      let phase = -1;
      for (let frame = 0; frame < 60; frame += 1) {
        // the playing frame moves 800 frames a display frame, the window ends there
        const base = 50_000 + frame * 800 - window;
        const x = wave("triangle", hz, base, window);
        const r = locate(tr, x, base, {
          hintHz: hz,
          sampleRate: SR,
          targetSpan: 900,
        });
        expect(r.period).toBeCloseTo(period, 0);
        // a whole period fits after the crossing
        expect(r.start + r.span).toBeLessThanOrEqual(window);
        const p = phaseOf(r.start + base, 0, period);
        if (phase >= 0) {
          expect(wrapDiff(p, phase, period)).toBeLessThan(0.5);
        }
        phase = p;
        const spans = Array.from(
          scopeTraceAt(x, r.start, r.span, 96, 32).spans
        );
        if (first) {
          const worst = spans.reduce(
            (m, v, i) => Math.max(m, Math.abs(v - (first?.[i] as number))),
            0
          );
          expect(worst).toBeLessThanOrEqual(1);
        } else {
          first = spans;
        }
      }
    }
  });

  it("finds the period of a low note with no hint, in the long window only", () => {
    const hz = 30;
    expect(
      searchPeriod(wave("triangle", hz, 7000, MAX_WINDOW)).lag
    ).toBeCloseTo(SR / hz, 0);
    // the old 1536 frame window holds less than one period of it: nothing to lock to
    expect(
      searchPeriod(wave("triangle", hz, 7000, MIN_WINDOW)).lag
    ).not.toBeCloseTo(SR / hz, 0);
  });

  it("finds the locked crossing near the lock the same as a search of the whole window", () => {
    for (const hz of [30, 110, 440]) {
      const period = SR / hz;
      const window = scopeWindowFrames(period);
      const span = Math.min(2 * period, window - period);
      const x = wave("triangle", hz, 12_345, window);
      const free = findTrigger(x, period, span);
      expect(free).toBeGreaterThanOrEqual(0);
      // a lock a few periods before, and one that does not match the wave's phase
      const locked = findTrigger(x, period, span, free - 3 * period);
      expect(wrapDiff(locked, free, period)).toBeLessThan(0.5);
      const other = findTrigger(x, period, span, free + period * 0.5);
      expect(other).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("level display", () => {
  const noise = (seed: number, n: number, gain: number) => {
    let s = seed;
    return Float32Array.from({ length: n }, () => {
      s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
      return (s / 2_147_483_648 - 0.5) * 2 * gain;
    });
  };

  it("takes the level path for noise channels and for sound with no period, not for steady pitch", () => {
    const m = createMode();
    // a noise channel never needs a period
    expect(levelMode(m, true, 0, false)).toBe(true);
    expect(levelMode(m, true, 120, false)).toBe(true);
    // a pitched channel shows its wave, and only gives it up after a run of frames with no period
    const p = createMode();
    for (let i = 0; i < 100; i += 1) {
      expect(levelMode(p, false, 109, false)).toBe(false);
    }
    for (let i = 1; i < LEVEL_ENTER_FRAMES; i += 1) {
      expect(levelMode(p, false, 0, false)).toBe(false);
    }
    expect(levelMode(p, false, 0, false)).toBe(true);
    // a rest changes nothing, a flicker of detection does not bring the wave back
    expect(levelMode(p, false, 0, true)).toBe(true);
    expect(levelMode(p, false, 109, false)).toBe(true);
    expect(levelMode(p, false, 0, false)).toBe(true);
    for (let i = 0; i < LEVEL_LEAVE_FRAMES; i += 1) {
      levelMode(p, false, 109, false);
    }
    expect(levelMode(p, false, 109, false)).toBe(false);
  });

  it("pulses up on a hit and falls at the release rate, whatever the noise does", () => {
    const s = createLevelState(48);
    const loud = noise(1, 2048, 0.6);
    const quiet = new Float32Array(2048);
    expect(s.db).toBe(LEVEL_FLOOR_DB);
    for (let i = 0; i < 8; i += 1) {
      updateLevel(s, noise(10 + i, 2048, 0.6), 0.016, 0.6);
    }
    // a uniform +-0.6 noise has an RMS of 0.35, about -9 dB; the attack has nearly reached it
    expect(s.db).toBeGreaterThan(levelDb(loud) - 1);
    const top = s.db;
    // a quiet channel (not silent): the level falls at the release rate
    updateLevel(s, quiet, 0.25, 0.01);
    expect(top - s.db).toBeCloseTo(RELEASE_DB_S * 0.25, 6);
    // a silent one clears fast
    updateLevel(s, quiet, 0.25, 0);
    expect(s.db).toBe(LEVEL_FLOOR_DB);
  });

  it("does not shimmer: noise of the same level draws the same bars frame after frame", () => {
    const s = createLevelState(48);
    const reach = 14;
    const drawn: number[][] = [];
    for (let i = 0; i < 40; i += 1) {
      // every frame is a different noise wave of the same level
      updateLevel(s, noise(100 + i, 2048, 0.5), 0.016, 0.5);
      if (i >= 20) {
        drawn.push(Array.from(columnHeights(s, reach)));
      }
    }
    for (const h of drawn) {
      h.forEach((v, c) => {
        expect(Math.abs(v - (drawn[0]?.[c] as number))).toBeLessThanOrEqual(1);
      });
    }
    // the texture is fixed (same every time) and trims columns without emptying them
    expect(Array.from(createTexture(48))).toEqual(Array.from(s.texture));
    expect(Math.min(...s.texture)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...s.texture)).toBeCloseTo(1, 6);
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
    for (let k = 0; k < 20; k += 1) {
      now += 16;
      stepBallistics(s, quiet, 0.016, now);
    }
    // the hold ended part way through these 320 ms: the marker fell, but by less than 320 ms at the fall rate
    expect(s.peaks[0]).toBeLessThan(peak);
    expect(s.peaks[0]).toBeGreaterThan(peak - PEAK_FALL_DB_S * 0.32);
  });

  it("uses the fast constants: a full bar falls in about a second, its marker follows after a short hold", () => {
    expect(RELEASE_DB_S).toBe(60);
    expect(PEAK_HOLD_MS).toBe(300);
    expect(PEAK_FALL_DB_S).toBe(40);
    const s = createBallistics(1);
    const hit = new Float32Array([0]);
    for (let t = 0; t < 10; t += 1) {
      stepBallistics(s, hit, 0.016, t * 16);
    }
    expect(s.bars[0]).toBeGreaterThan(-3);
    const quiet = new Float32Array([DB_FLOOR]);
    let now = 160;
    let barEmptyAt = -1;
    let peakEmptyAt = -1;
    while (peakEmptyAt < 0 && now < 5000) {
      now += 16;
      stepBallistics(s, quiet, 0.016, now);
      if (barEmptyAt < 0 && (s.bars[0] as number) <= DB_FLOOR) {
        barEmptyAt = now - 160;
      }
      if ((s.peaks[0] as number) <= DB_FLOOR) {
        peakEmptyAt = now - 160;
      }
    }
    // 72 dB at 60 dB/s is 1.2 s for the bar, the marker holds 300 ms then falls 72 dB at 40 dB/s
    expect(barEmptyAt).toBeGreaterThan(1100);
    expect(barEmptyAt).toBeLessThan(1350);
    expect(peakEmptyAt).toBeGreaterThan(300 + 1600);
    expect(peakEmptyAt).toBeLessThan(300 + 2000);
  });

  it("clears bars and peak markers in well under a second once the sound has stopped", () => {
    const s = createBallistics(3);
    const hit = new Float32Array([0, -10, -30]);
    for (let t = 0; t < 20; t += 1) {
      stepBallistics(s, hit, 0.016, t * 16);
    }
    const quiet = new Float32Array(3).fill(DB_FLOOR);
    let now = 320;
    let emptyAt = -1;
    while (emptyAt < 0 && now < 5000) {
      now += 16;
      stepBallistics(s, quiet, 0.016, now, true);
      const gone = [...s.bars, ...s.peaks].every((v) => v <= DB_FLOOR);
      if (gone) {
        emptyAt = now - 320;
      }
    }
    expect(emptyAt).toBeGreaterThan(0);
    expect(emptyAt).toBeLessThanOrEqual(72_000 / STOP_FALL_DB_S + 32);
    expect(emptyAt).toBeLessThan(800);
    // a silent master is under the spectrum floor, a quiet one is not
    expect(SILENT_PEAK).toBeLessThan(10 ** (DB_FLOOR / 20) * 2);
  });
});
