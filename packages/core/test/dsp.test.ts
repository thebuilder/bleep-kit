import { describe, expect, it } from "vitest";
import * as nes from "../src/chips/nes.ts";
import { Echo } from "../src/dsp/echo.ts";
import {
  ENV_IDLE,
  envelopeRelease,
  envelopeTrigger,
  newEnvelope,
  runEnvelope,
  setEnvelopeParams,
} from "../src/dsp/envelope.ts";
import { MOD_INDEX, rateSeconds } from "../src/dsp/fm.ts";
import { LIMITER_CEILING, Limiter } from "../src/dsp/limiter.ts";
import {
  compileMacro,
  macroRelease,
  macroStart,
  macroTick,
} from "../src/dsp/macro.ts";
import {
  NOISE_GB_SHORT,
  NOISE_NES_LONG,
  NOISE_NES_SHORT,
  NOISE_PSG_PERIODIC,
  newNoise,
  seedNoise,
  stepNoise,
} from "../src/dsp/noise.ts";
import {
  newPhase,
  renderPulse,
  renderSaw,
  renderStepped,
  renderTriangle,
} from "../src/dsp/osc.ts";
import { setSidFilter } from "../src/dsp/sid-filter.ts";
import { newSvf, svfProcess } from "../src/dsp/svf.ts";
import { nesTriangleTable, oplWave, sineTable } from "../src/dsp/tables.ts";
import type { ChannelKind, ChipId } from "../src/index.ts";
import {
  defaultInstrument,
  noteToHz,
  renderInstrumentNote,
} from "../src/index.ts";
import { mulberry32 } from "../src/prng.ts";
import { bandEnergy, fftPeakHz, toDb, zeroCrossingHz } from "./helpers.ts";

const SR = 48_000;

describe("oscillators", () => {
  it.each([0.125, 0.25, 0.5, 0.75])(
    "pulse duty %f measured by counting samples above zero",
    (duty) => {
      const hz = 441;
      const n = Math.round((SR / hz) * 100);
      const out = new Float32Array(n);
      const ph = newPhase();
      ph.dt = hz / SR;
      renderPulse(ph, duty, out, n);
      let high = 0;
      for (let i = 0; i < n; i += 1) {
        if ((out[i] ?? 0) > 0) {
          high += 1;
        }
      }
      expect(Math.abs(high / n - duty)).toBeLessThan(0.01);
    }
  );

  it("triangle, saw and pulse land on 440 Hz by zero crossings and FFT", () => {
    const n = SR;
    for (const render of [
      (ph: ReturnType<typeof newPhase>, o: Float32Array) =>
        renderPulse(ph, 0.5, o, n),
      (ph: ReturnType<typeof newPhase>, o: Float32Array) =>
        renderTriangle(ph, o, n),
      (ph: ReturnType<typeof newPhase>, o: Float32Array) => renderSaw(ph, o, n),
    ]) {
      const out = new Float32Array(n);
      const ph = newPhase();
      ph.dt = 440 / SR;
      render(ph, out);
      expect(Math.abs(zeroCrossingHz(out, SR) - 440) / 440).toBeLessThan(0.005);
      expect(Math.abs(fftPeakHz(out, SR, 0, 16_384) - 440) / 440).toBeLessThan(
        0.005
      );
    }
  });

  it("the NES triangle table has 32 steps over 16 levels (15 down to 0 and back up)", () => {
    const t = nesTriangleTable();
    expect(t).toHaveLength(32);
    const levels = new Set(
      Array.from(t, (v) => Math.round(((v + 1) / 2) * 15))
    );
    expect(levels.size).toBe(16);
    const out = new Float32Array(64);
    const ph = newPhase();
    ph.dt = 1 / 32;
    renderStepped(ph, t, out, 64);
    expect(out[0]).toBeCloseTo(out[32] ?? 0, 6);
  });
});

describe("every source plays 440 Hz at the contract tolerance", () => {
  const cases: [ChipId, ChannelKind][] = [
    ["custom", "pulse"],
    ["custom", "triangle"],
    ["custom", "wave"],
    ["custom", "sid"],
    ["custom", "fm"],
    ["nes", "pulse"],
    ["nes", "triangle"],
    ["gameboy", "pulse"],
    ["gameboy", "wave"],
    ["c64", "sid"],
    ["genesis", "fm"],
    ["genesis", "pulse"],
    ["adlib", "fm"],
  ];
  it.each(cases)("%s %s", (chip, kind) => {
    const inst = defaultInstrument(kind);
    inst.envelope = { attack: 0.002, decay: 0.05, release: 0.05, sustain: 1 };
    inst.volume = 1;
    if (kind === "fm" && inst.fm) {
      inst.fm.feedback = 0;
    }
    const r = renderInstrumentNote(inst, 69, {
      chip,
      duration: 1,
      release: 0.1,
      sampleRate: SR,
    });
    const left = r.channels[0] ?? new Float32Array();
    const seg = left.subarray(Math.round(0.2 * SR), Math.round(0.9 * SR));
    const peak = fftPeakHz(seg, SR);
    expect(Math.abs(peak - 440) / 440).toBeLessThan(0.005);
    expect(Math.abs(zeroCrossingHz(seg, SR) - 440) / 440).toBeLessThan(0.005);
  });
});

describe("NES period quantization", () => {
  it("rounds to the 11-bit timer: A-4 is 1.6 cents sharp, A-7 is 12 cents flat", () => {
    const cents = (hz: number, target: number) => 1200 * Math.log2(hz / target);
    expect(cents(nes.quantizePulseHz(440), 440)).toBeCloseTo(1.6, 1);
    expect(cents(nes.quantizePulseHz(3520), 3520)).toBeCloseTo(-12, 0);
    expect(nes.hzToPeriod(440)).toBe(253);
    expect(nes.periodToHz(253)).toBeCloseTo(440.4, 1);
  });

  it("triangle runs an octave lower per period (32 steps instead of 16)", () => {
    expect(nes.quantizeTriangleHz(440)).toBeCloseTo(
      nes.quantizePulseHz(440),
      1
    );
    expect(nes.hzToPeriod(220, "triangle")).toBe(nes.hzToPeriod(440, "pulse"));
  });

  it("clamps to the 11-bit register", () => {
    expect(nes.hzToPeriod(5)).toBe(2047);
    expect(nes.hzToPeriod(0.1)).toBe(2047);
  });
});

describe("OPL waveform select", () => {
  const table = sineTable();
  const at = (w: number, phase: number) => oplWave(table, w, phase);

  it("0 is a sine", () => {
    expect(at(0, 0.25)).toBeCloseTo(1, 3);
    expect(at(0, 0.75)).toBeCloseTo(-1, 3);
  });

  it("1 keeps the positive half and silences the negative one", () => {
    expect(at(1, 0.25)).toBeCloseTo(1, 3);
    expect(at(1, 0.75)).toBe(0);
  });

  it("2 is the absolute value, so both halves are positive", () => {
    expect(at(2, 0.25)).toBeCloseTo(1, 3);
    expect(at(2, 0.75)).toBeCloseTo(1, 3);
  });

  it("3 plays the rising quarter of each half and silences the other", () => {
    expect(at(3, 0.125)).toBeGreaterThan(0.5);
    expect(at(3, 0.375)).toBe(0);
    expect(at(3, 0.625)).toBeGreaterThan(0.5);
    expect(at(3, 0.875)).toBe(0);
  });

  it("4 is a double speed sine in the first half and silent in the second", () => {
    expect(at(4, 0.125)).toBeCloseTo(1, 3);
    expect(at(4, 0.375)).toBeCloseTo(-1, 3);
    expect(at(4, 0.75)).toBe(0);
  });

  it("5 is the same with the absolute value", () => {
    expect(at(5, 0.125)).toBeCloseTo(1, 3);
    expect(at(5, 0.375)).toBeCloseTo(1, 3);
    expect(at(5, 0.75)).toBe(0);
  });

  it("6 is a square wave", () => {
    expect(at(6, 0.1)).toBe(1);
    expect(at(6, 0.9)).toBe(-1);
  });

  it("7 is a fat, camel shaped wave, positive in the first half and negative in the second", () => {
    expect(at(7, 0.25)).toBeCloseTo(1, 3);
    expect(at(7, 0.75)).toBeCloseTo(-1, 3);
    expect(at(7, 0.01)).toBeGreaterThan(0);
    expect(at(7, 0.01)).toBeLessThan(at(7, 0.25));
  });

  it("anything else falls back to the sine", () => {
    expect(at(9, 0.25)).toBe(at(0, 0.25));
  });
});

describe("envelope", () => {
  it("attack reaches 0.99 within the attack time plus 1 ms", () => {
    for (const attack of [0.001, 0.01, 0.1]) {
      const e = newEnvelope();
      setEnvelopeParams(e, attack, 1, 1, 0.1, SR);
      envelopeTrigger(e);
      const out = new Float32Array(Math.round((attack + 0.001) * SR));
      runEnvelope(e, out, out.length);
      expect(out.at(-1)).toBeGreaterThanOrEqual(0.99);
    }
  });

  it("release falls below -60 dB within 1.2 times the release time", () => {
    for (const release of [0.02, 0.2, 1]) {
      const e = newEnvelope();
      setEnvelopeParams(e, 0, 0.1, 1, release, SR);
      envelopeTrigger(e);
      runEnvelope(e, new Float32Array(2000), 2000);
      envelopeRelease(e);
      const n = Math.round(release * 1.2 * SR);
      const out = new Float32Array(n);
      runEnvelope(e, out, n);
      expect(out[n - 1]).toBeLessThan(0.001);
    }
  });

  it("never steps by more than a declick ramp, and reaches idle", () => {
    const e = newEnvelope();
    setEnvelopeParams(e, 0, 0.05, 0.5, 0, SR);
    envelopeTrigger(e);
    const out = new Float32Array(4000);
    runEnvelope(e, out, 4000);
    let maxStep = 0;
    for (let i = 1; i < out.length; i += 1) {
      maxStep = Math.max(maxStep, Math.abs((out[i] ?? 0) - (out[i - 1] ?? 0)));
    }
    expect(maxStep).toBeLessThan(0.05);
    envelopeRelease(e);
    runEnvelope(e, new Float32Array(SR), SR);
    expect(e.stage).toBe(ENV_IDLE);
  });
});

describe("macros", () => {
  it("loops back to the loop index", () => {
    const m = compileMacro({ loop: 1, release: -1, values: [1, 2, 3, 4] });
    macroStart(m);
    const seen = [m.value];
    for (let i = 0; i < 7; i += 1) {
      macroTick(m);
      seen.push(m.value);
    }
    expect(seen).toEqual([1, 2, 3, 4, 2, 3, 4, 2]);
  });

  it("holds the last value without a loop", () => {
    const m = compileMacro({ loop: -1, release: -1, values: [5, 6] });
    macroStart(m);
    macroTick(m);
    macroTick(m);
    macroTick(m);
    expect(m.value).toBe(6);
  });

  it("jumps to the release index on note off and then runs to the end", () => {
    const m = compileMacro({ loop: 1, release: 3, values: [1, 1, 1, 9, 8, 7] });
    macroStart(m);
    macroTick(m);
    macroRelease(m);
    expect(m.value).toBe(9);
    macroTick(m);
    macroTick(m);
    macroTick(m);
    macroTick(m);
    expect(m.value).toBe(7);
  });
});

describe("LFSR noise", () => {
  function period(mode: number, seed: number, warmup = 0): number {
    const s = newNoise();
    seedNoise(s, mode, seed);
    for (let i = 0; i < warmup; i += 1) {
      stepNoise(s);
    }
    const start = s.lfsr;
    for (let i = 1; i <= 40_000; i += 1) {
      stepNoise(s);
      if (s.lfsr === start) {
        return i;
      }
    }
    return -1;
  }

  it("NES short mode repeats after 93 steps (or 31 for some seeds)", () => {
    const seen = new Set<number>();
    for (let seed = 1; seed < 200; seed += 7) {
      seen.add(period(NOISE_NES_SHORT, seed));
    }
    for (const p of seen) {
      expect([93, 31]).toContain(p);
    }
    expect(seen.has(93)).toBe(true);
  });

  it("NES long mode has the full 32767 step period", () => {
    expect(period(NOISE_NES_LONG, 1)).toBe(32_767);
  });

  it("Game Boy short mode and PSG periodic mode are short cycles", () => {
    expect(period(NOISE_GB_SHORT, 1, 400)).toBe(127);
    expect(period(NOISE_PSG_PERIODIC, 1, 400)).toBe(15);
  });
});

describe("SID filter", () => {
  it("lowpass removes at least 12 dB per octave above the cutoff", () => {
    const rng = mulberry32(5);
    const n = 1 << 16;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      x[i] = rng() * 2 - 1;
    }
    const f = newSvf();
    // cutoff 0.5 maps to about 600 Hz
    setSidFilter(f, 0.5, 0, 1, SR);
    const fc = 30 * (12_000 / 30) ** 0.5;
    svfProcess(f, x, n);
    const below = bandEnergy(x, SR, fc / 2, fc, 2048, 1 << 15);
    const octave1 = bandEnergy(x, SR, fc * 2, fc * 4, 2048, 1 << 15);
    const octave2 = bandEnergy(x, SR, fc * 4, fc * 8, 2048, 1 << 15);
    // energy per Hz drops by at least 12 dB per octave
    const perHz = (e: number, lo: number, hi: number) => e / (hi - lo);
    expect(
      toDb(Math.sqrt(perHz(below, fc / 2, fc))) -
        toDb(Math.sqrt(perHz(octave1, fc * 2, fc * 4)))
    ).toBeGreaterThan(12);
    expect(
      toDb(Math.sqrt(perHz(octave1, fc * 2, fc * 4))) -
        toDb(Math.sqrt(perHz(octave2, fc * 4, fc * 8)))
    ).toBeGreaterThan(11);
  });
});

describe("limiter", () => {
  it("never exceeds -0.3 dBFS on a +12 dB input", () => {
    const lim = new Limiter(SR);
    const n = SR;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = 4 * Math.sin((2 * Math.PI * 220 * i) / SR);
      l[i] = v;
      r[i] = v * 0.7;
    }
    for (let o = 0; o < n; o += 128) {
      lim.process(l.subarray(o, o + 128), r.subarray(o, o + 128), 128);
    }
    let peak = 0;
    for (let i = 0; i < n; i += 1) {
      peak = Math.max(peak, Math.abs(l[i] ?? 0), Math.abs(r[i] ?? 0));
    }
    expect(peak).toBeLessThanOrEqual(LIMITER_CEILING + 1e-6);
    expect(toDb(peak)).toBeLessThanOrEqual(-0.29);
  });

  it("passes quiet audio unchanged apart from the lookahead delay", () => {
    const lim = new Limiter(SR);
    const n = 4096;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      l[i] = 0.3 * Math.sin((2 * Math.PI * 300 * i) / SR);
      r[i] = l[i] ?? 0;
    }
    const ref = l.slice();
    lim.process(l, r, n);
    const d = lim.latency;
    for (let i = d + 10; i < n; i += 1) {
      expect(l[i]).toBeCloseTo(ref[i - d] ?? 0, 6);
    }
  });

  it("recovers its gain after a loud burst", () => {
    const lim = new Limiter(SR);
    const n = SR;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const amp = i < 2000 ? 3 : 0.25;
      l[i] = amp * Math.sin((2 * Math.PI * 440 * i) / SR);
      r[i] = l[i] ?? 0;
    }
    lim.process(l, r, n);
    let peak = 0;
    for (let i = n - 4800; i < n; i += 1) {
      peak = Math.max(peak, Math.abs(l[i] ?? 0));
    }
    expect(peak).toBeGreaterThan(0.24);
  });
});

describe("echo", () => {
  it("repeats at the delay time (cross correlation peak)", () => {
    const echo = new Echo(SR);
    echo.configure(0.1, 0.5, 1, 20_000);
    const n = SR / 2;
    const rng = mulberry32(3);
    const input = new Float32Array(n);
    for (let i = 0; i < 2000; i += 1) {
      input[i] = rng() * 2 - 1;
    }
    const out = new Float32Array(n);
    const dummy = new Float32Array(n);
    for (let o = 0; o < n; o += 128) {
      echo.process(
        input.subarray(o, o + 128),
        input.subarray(o, o + 128),
        out.subarray(o, o + 128),
        dummy.subarray(o, o + 128),
        128
      );
    }
    let best = 0;
    let bestLag = 0;
    for (let lag = 100; lag < 12_000; lag += 1) {
      let c = 0;
      for (let i = 0; i < 2000; i += 1) {
        c += (input[i] ?? 0) * (out[i + lag] ?? 0);
      }
      if (c > best) {
        best = c;
        bestLag = lag;
      }
    }
    expect(Math.abs(bestLag - 0.1 * SR)).toBeLessThanOrEqual(2);
  });
});

describe("fm constants", () => {
  it("pins the modulation index and the rate table", () => {
    expect(MOD_INDEX).toBe(8);
    expect(rateSeconds(0)).toBe(10);
    expect(rateSeconds(25)).toBeCloseTo(10 * 2 ** -10, 9);
    expect(rateSeconds(31)).toBeLessThan(0.02);
  });

  it("a higher modulation level adds spectral energy at the sidebands", () => {
    const render = (modLevel: number) => {
      const inst = defaultInstrument("fm");
      if (inst.fm) {
        inst.fm.algorithm = 0;
        inst.fm.feedback = 0;
        const { ops } = inst.fm;
        // operator 1 is the modulator, operator 4 the carrier, 2 and 3 stay silent
        const levels = [modLevel, 0, 0, 1];
        ops.forEach((op, i) => {
          op.attack = 31;
          op.decay = 0;
          op.sustainLevel = 1;
          op.level = levels[i] ?? 0;
          op.mult = 1;
        });
        // 1 > 2 > 3 > 4 with operators 2 and 3 silent in level: use only 1 and 4 via algorithm 7 variant
        inst.fm.algorithm = 4;
        const [, second, third] = ops;
        if (second) {
          second.level = 1;
        }
        if (third) {
          third.level = 0;
        }
      }
      inst.envelope = { attack: 0, decay: 0.1, release: 0.05, sustain: 1 };
      const r = renderInstrumentNote(inst, 69, {
        chip: "custom",
        duration: 0.5,
        release: 0.05,
        sampleRate: SR,
      });
      return r.channels[0] ?? new Float32Array();
    };
    const lowMod = render(0.05);
    const highMod = render(1);
    const sideEnergy = (b: Float32Array) =>
      bandEnergy(b, SR, 600, 3000, 4800, 16_384);
    expect(sideEnergy(highMod)).toBeGreaterThan(sideEnergy(lowMod) * 10);
  });
});

describe("note frequencies", () => {
  it("noteToHz matches A-4 and the octave rule", () => {
    expect(noteToHz(69)).toBe(440);
    expect(noteToHz(81)).toBeCloseTo(880, 9);
  });
});
