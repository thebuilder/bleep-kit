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
import { Limiter } from "../src/dsp/limiter.ts";
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
  renderNoise,
  seedNoise,
  stepNoise,
} from "../src/dsp/noise.ts";
import type { PhaseState } from "../src/dsp/osc.ts";
import {
  newPhase,
  renderPulse,
  renderSaw,
  renderSine,
  renderStepped,
  renderTriangle,
} from "../src/dsp/osc.ts";
import type { SidOsc } from "../src/dsp/sid.ts";
import { newSidOsc, renderSidGroup, sidSetRate } from "../src/dsp/sid.ts";
import { setSidFilter } from "../src/dsp/sid-filter.ts";
import { newSvf, SVF_BP, SVF_HP, SVF_LP, svfProcess } from "../src/dsp/svf.ts";
import { nesTriangleTable, oplWave, sineTable } from "../src/dsp/tables.ts";
import type { ChannelKind, ChipId, Instrument } from "../src/index.ts";
import {
  defaultInstrument,
  noteToHz,
  renderInstrumentNote,
} from "../src/index.ts";
import { mulberry32 } from "../src/prng.ts";
import { bandEnergy, fftPeakHz, rms, toDb, zeroCrossingHz } from "./helpers.ts";

const SR = 48_000;

/** The limiter ceiling of the contract (architecture 3.8) as a linear amplitude: -0.3 dBFS. */
const CEILING = 10 ** (-0.3 / 20);

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

  const sources: [
    string,
    (ph: PhaseState, out: Float32Array, n: number) => void,
  ][] = [
    ["pulse", (ph, out, n) => renderPulse(ph, 0.5, out, n)],
    ["triangle", (ph, out, n) => renderTriangle(ph, out, n)],
    ["saw", (ph, out, n) => renderSaw(ph, out, n)],
    ["sine", (ph, out, n) => renderSine(ph, sineTable(), out, n)],
  ];

  it.each(sources)(
    "%s lands on 440 Hz by zero crossings and FFT",
    (_, render) => {
      const out = new Float32Array(SR);
      const ph = newPhase();
      ph.dt = 440 / SR;
      render(ph, out, SR);
      expect(Math.abs(zeroCrossingHz(out, SR) - 440) / 440).toBeLessThan(0.005);
      expect(Math.abs(fftPeakHz(out, SR, 0, 16_384) - 440) / 440).toBeLessThan(
        0.005
      );
    }
  );

  it("the NES triangle steps from level 15 down to 0 and back up, one level per step", () => {
    const table = nesTriangleTable();
    const levels = Array.from(table, (v) => Math.round(((v + 1) * 15) / 2));
    const down = Array.from({ length: 16 }, (_, i) => 15 - i);
    const up = Array.from({ length: 16 }, (_, i) => i);
    expect(levels).toEqual([...down, ...up]);
    expect(Math.min(...table)).toBe(-1);
    expect(Math.max(...table)).toBe(1);
    // a phase increment of 1/32 plays one table entry per sample, over and over
    const out = new Float32Array(64);
    const ph = newPhase();
    ph.dt = 1 / 32;
    renderStepped(ph, table, out, 64);
    expect(Array.from(out)).toEqual([...table, ...table]);
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
    // period = round(1789773 / (16 * hz)) - 1: 440 Hz -> round(254.18) - 1 = 253, 3520 Hz -> round(31.78) - 1 = 31
    const cents = (hz: number, target: number) => 1200 * Math.log2(hz / target);
    expect(cents(nes.quantizePulseHz(440), 440)).toBeCloseTo(1.6, 1);
    expect(cents(nes.quantizePulseHz(3520), 3520)).toBeCloseTo(-12, 0);
    expect(nes.hzToPeriod(440)).toBe(253);
    expect(nes.periodToHz(253)).toBeCloseTo(440.4, 1);
  });

  it("the triangle timer counts 32 steps per cycle, so it plays an octave below a pulse of the same period", () => {
    // period = round(1789773 / (32 * hz)) - 1: 110 Hz -> round(508.46) - 1 = 507, played at 1789773 / (32 * 508) Hz
    expect(nes.hzToPeriod(110, "triangle")).toBe(507);
    expect(nes.quantizeTriangleHz(110)).toBeCloseTo(110.1, 1);
    expect(nes.hzToPeriod(220, "triangle")).toBe(nes.hzToPeriod(440, "pulse"));
  });

  it("stays inside the register: very low and zero pitches clamp to 2047, very high pulses stop at 8", () => {
    expect(nes.hzToPeriod(5)).toBe(2047);
    // a zero frequency must not divide by zero
    expect(nes.hzToPeriod(0)).toBe(2047);
    // the 2A03 mutes a pulse whose timer is below 8, so the highest note is register 8 (about 12.4 kHz)
    expect(nes.hzToPeriod(20_000)).toBe(8);
    expect(nes.quantizePulseHz(20_000)).toBeCloseTo(12_429, 0);
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

  it("7 is a fat sine: positive and peaking at 1 in the first half, its mirror image in the second", () => {
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
  /** An envelope that has been triggered and run long enough to sit at its sustain level. */
  function sustained(
    attack: number,
    decay: number,
    sustain: number,
    release: number
  ) {
    const e = newEnvelope();
    setEnvelopeParams(e, attack, decay, sustain, release, SR);
    envelopeTrigger(e);
    runEnvelope(e, new Float32Array(SR), SR);
    return e;
  }

  it.each([0.001, 0.01, 0.1])(
    "a %f s attack reaches 0.99 within the attack time plus 1 ms",
    (attack) => {
      const e = newEnvelope();
      setEnvelopeParams(e, attack, 1, 1, 0.1, SR);
      envelopeTrigger(e);
      const out = new Float32Array(Math.round((attack + 0.001) * SR));
      runEnvelope(e, out, out.length);
      expect(out.at(-1)).toBeGreaterThanOrEqual(0.99);
    }
  );

  it.each([0.01, 0.1])(
    "a %f s attack is linear: half way through it the level is 0.5",
    (attack) => {
      const e = newEnvelope();
      setEnvelopeParams(e, attack, 1, 1, 0.1, SR);
      envelopeTrigger(e);
      const half = Math.round((attack / 2) * SR);
      const out = new Float32Array(half);
      runEnvelope(e, out, half);
      expect(out[half - 1]).toBeCloseTo(0.5, 1);
    }
  );

  it.each([0.02, 0.2, 1])(
    "a %f s release is exponential: -30 dB half way and below -60 dB within 1.2 times the release time",
    (release) => {
      const e = sustained(0, 0.1, 1, release);
      envelopeRelease(e);
      const n = Math.round(release * 1.2 * SR);
      const out = new Float32Array(n);
      runEnvelope(e, out, n);
      const half = toDb(out[Math.round((release / 2) * SR) - 1] ?? 0);
      expect(half).toBeGreaterThan(-33);
      expect(half).toBeLessThan(-27);
      expect(out[n - 1]).toBeLessThan(0.001);
    }
  );

  it("the decay settles on the sustain level within the decay time and holds it", () => {
    const e = newEnvelope();
    setEnvelopeParams(e, 0, 0.1, 0.4, 0.1, SR);
    envelopeTrigger(e);
    const out = new Float32Array(SR);
    runEnvelope(e, out, SR);
    // 60 dB of the 0.6 drop is gone at the decay time: within 0.001 of the way to the sustain
    expect(out[Math.round(0.1 * SR)]).toBeLessThan(0.4 + 0.6 * 0.002);
    expect(out[Math.round(0.1 * SR)]).toBeGreaterThanOrEqual(0.4);
    for (let i = Math.round(0.3 * SR); i < SR; i += 1) {
      expect(out[i]).toBe(Math.fround(0.4));
    }
  });

  it("a zero attack and a zero release still ramp, so a note start and stop do not click", () => {
    const e = newEnvelope();
    setEnvelopeParams(e, 0, 0.05, 0.5, 0, SR);
    envelopeTrigger(e);
    const start = new Float32Array(4000);
    runEnvelope(e, start, 4000);
    // the first step counts too: it leaves the idle level 0
    let worstUp = start[0] ?? 0;
    for (let i = 1; i < start.length; i += 1) {
      worstUp = Math.max(
        worstUp,
        Math.abs((start[i] ?? 0) - (start[i - 1] ?? 0))
      );
    }
    expect(worstUp).toBeLessThan(0.05);
    expect(start.at(-1)).toBeCloseTo(0.5, 3);
    envelopeRelease(e);
    const stop = new Float32Array(SR);
    runEnvelope(e, stop, SR);
    let worstDown = 0.5 - (stop[0] ?? 0);
    for (let i = 1; i < stop.length; i += 1) {
      worstDown = Math.max(
        worstDown,
        Math.abs((stop[i] ?? 0) - (stop[i - 1] ?? 0))
      );
    }
    // a hard cut would drop the whole 0.5 at once
    expect(worstDown).toBeLessThan(0.1);
    expect(e.stage).toBe(ENV_IDLE);
    expect(stop.at(-1)).toBe(0);
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

  it.each([0, 32_767, 65_534, -5])(
    "seed %i never leaves the register empty, which would lock the noise at one level",
    (seed) => {
      const s = newNoise();
      seedNoise(s, NOISE_NES_LONG, seed);
      expect(s.lfsr).not.toBe(0);
      const bits = new Set<number>();
      for (let i = 0; i < 64; i += 1) {
        bits.add(stepNoise(s));
      }
      expect(bits).toEqual(new Set([-1, 1]));
    }
  );

  it("a generator clocked slower than the host rate holds each bit for the steps' worth of samples", () => {
    const s = newNoise();
    seedNoise(s, NOISE_NES_LONG, 1);
    s.stepsPerSample = 0.25;
    const out = new Float32Array(400);
    renderNoise(s, out, out.length);
    // one LFSR step every 4 host samples: the output can only change on every fourth sample and is a full-scale bit
    for (let i = 1; i < out.length; i += 1) {
      if (i % 4 !== 3) {
        expect(out[i]).toBe(out[i - 1]);
      }
      expect(Math.abs(out[i] ?? 0)).toBe(1);
    }
    expect(new Set(out).size).toBe(2);
  });

  it("averaging lifts the level by sqrt(steps) capped at 2, so a fast hiss is quieter than a slow boom", () => {
    const level = (stepsPerSample: number) => {
      const s = newNoise();
      seedNoise(s, NOISE_NES_LONG, 1);
      s.stepsPerSample = stepsPerSample;
      const out = new Float32Array(48_000);
      renderNoise(s, out, out.length);
      return rms(out);
    };
    // Averaging N independent +-1 bits leaves 1 / sqrt(N) of the level and the lift gives back min(sqrt(N), 2), so
    // sixteen steps sit at 1/4 * 2 = 0.5 and four steps at 1/2 * 2 = 1: a ratio of 0.5. The LFSR bits are not
    // independent, which moves it to about 0.6; the old lift cap of 3 gave about 0.9.
    expect(level(1)).toBeCloseTo(1, 1);
    expect(level(16) / level(4)).toBeGreaterThan(0.4);
    expect(level(16) / level(4)).toBeLessThan(0.7);
  });
});

describe("SID oscillators", () => {
  const CLOCK = 985_248;
  // waveform mask bits of the contract (architecture 3.4): 1 tri, 2 saw, 4 pulse, 8 noise
  const TRI = 1;
  const SAW = 2;
  /** Two samples short of a whole number of samples per cycle, so no phase boundary lands exactly on a sample. */
  const MASTER_PERIOD = 191;

  function voice(mask: number, hz: number, opts: Partial<SidOsc> = {}): SidOsc {
    const o = newSidOsc();
    o.active = true;
    o.mask = mask;
    // the frequency register F runs the accumulator at F * clock / 2^24 Hz
    sidSetRate(o, (hz * 2 ** 24) / CLOCK, CLOCK, SR);
    return Object.assign(o, opts);
  }

  /** Render voices 0 (the one under test), 1 (idle) and 2 (its modulator: voice i is modulated by voice i - 1, cyclic). */
  function render(
    mask: number,
    hz: number,
    opts: Partial<SidOsc>,
    n: number
  ): { slave: Float32Array; master: Float32Array } {
    const outs = [0, 1, 2].map(() => new Float32Array(n));
    const idle = newSidOsc();
    renderSidGroup(
      [
        voice(mask, hz, opts),
        idle,
        voice(SAW, SR / MASTER_PERIOD, { active: true }),
      ],
      outs,
      n
    );
    return { master: outs[2] as Float32Array, slave: outs[0] as Float32Array };
  }

  it("hard sync restarts the slave with the master, so it repeats at the master's period", () => {
    const n = 2000;
    const synced = render(SAW, 700, { sync: true }, n).slave;
    for (let i = MASTER_PERIOD * 2; i < n; i += 1) {
      expect(synced[i]).toBeCloseTo(synced[i - MASTER_PERIOD] ?? 0, 6);
    }
    // without sync the 700 Hz slave does not fit the master's cycle, so the same comparison fails
    const free = render(SAW, 700, { sync: false }, n).slave;
    let worst = 0;
    for (let i = MASTER_PERIOD * 2; i < n; i += 1) {
      worst = Math.max(
        worst,
        Math.abs((free[i] ?? 0) - (free[i - MASTER_PERIOD] ?? 0))
      );
    }
    expect(worst).toBeGreaterThan(0.5);
  });

  it("ring modulation turns the triangle upside down while the master's top bit is set", () => {
    const n = 2000;
    const plain = render(TRI, 300, { ring: false }, n);
    const ring = render(TRI, 300, { ring: true }, n);
    let inverted = 0;
    for (let i = 0; i < n; i += 1) {
      // a rising saw is positive exactly while the top bit of its accumulator is set
      const topBit = (plain.master[i] ?? 0) > 0;
      if (topBit) {
        inverted += 1;
      }
      expect(ring.slave[i]).toBeCloseTo(
        (topBit ? -1 : 1) * (plain.slave[i] ?? 0),
        5
      );
    }
    // the master's top bit is set for half of its cycle
    expect(inverted / n).toBeCloseTo(0.5, 1);
  });

  it("combined waveforms are the bitwise AND of the 12-bit waves", () => {
    const n = 1000;
    const to12 = (x: number) => Math.round((x + 1) * 2047.5);
    const tri = render(TRI, 300, {}, n).slave;
    const saw = render(SAW, 300, {}, n).slave;
    const both = render(TRI | SAW, 300, {}, n).slave;
    for (let i = 0; i < n; i += 1) {
      const want = to12(tri[i] ?? 0) & to12(saw[i] ?? 0);
      expect(to12(both[i] ?? 0)).toBe(want);
    }
  });
});

describe("SID filter", () => {
  /** Gain in dB of the SID filter at hz, measured on the second half of a steady sine. */
  function gainDb(
    cutoff: number,
    resonance: number,
    mode: number,
    hz: number
  ): number {
    const f = newSvf();
    setSidFilter(f, cutoff, resonance, mode, SR);
    const x = new Float32Array(SR);
    for (let i = 0; i < SR; i += 1) {
      x[i] = 0.1 * Math.sin((2 * Math.PI * hz * i) / SR);
    }
    svfProcess(f, x, SR);
    return toDb(rms(x, SR / 2) / (0.1 * Math.SQRT1_2));
  }

  /** The analog second order response at r = f / fc: low, band (0 dB at the peak) or high pass of quality q. */
  function secondOrderDb(mode: number, r: number, q: number): number {
    const numerator = { [SVF_LP]: 1, [SVF_BP]: r / q, [SVF_HP]: r * r }[mode];
    return toDb((numerator ?? 0) / Math.sqrt((1 - r * r) ** 2 + (r / q) ** 2));
  }

  // cutoff 0 to 1 maps to 30 Hz to 12 kHz on a log scale, so 0.5 is 30 * 400 ^ 0.5 = 600 Hz
  it.each([
    [0, 30],
    [0.5, 600],
    [1, 12_000],
  ])(
    "cutoff %f puts the corner at %i Hz (a critically damped lowpass is 6 dB down there)",
    (cutoff, hz) => {
      expect(Math.abs(gainDb(cutoff, 0, SVF_LP, hz) + 6.02)).toBeLessThan(1);
    }
  );

  // resonance 0 to 1 maps to Q 0.5 to 8, and a lowpass peaks at Q times its passband at the corner
  it.each([
    [0, 0.5],
    [0.5, 4.25],
    [1, 8],
  ])(
    "resonance %f is Q %f: the corner of the lowpass sits at 20 log10(Q) dB",
    (resonance, q) => {
      expect(
        Math.abs(gainDb(0.5, resonance, SVF_LP, 600) - toDb(q))
      ).toBeLessThan(1);
    }
  );

  it.each([
    ["lowpass", SVF_LP],
    ["bandpass", SVF_BP],
    ["highpass", SVF_HP],
  ])("the %s follows a 12 dB per octave second order response", (_, mode) => {
    for (const r of [1 / 8, 1 / 2, 1, 2, 8]) {
      const want = secondOrderDb(mode, r, 4.25);
      expect(
        Math.abs(gainDb(0.5, 0.5, mode, 600 * r) - want),
        `${r} x the corner`
      ).toBeLessThan(1);
    }
  });
});

describe("SID filter routing", () => {
  /** Energy below 300 Hz and above 3 kHz of a 220 Hz saw on the c64 with the patch's filter set as given. */
  function bands(mode: "off" | "lp" | "bp" | "hp", cutoff: number) {
    const inst = defaultInstrument("sid");
    inst.envelope = { attack: 0.002, decay: 0.05, release: 0.05, sustain: 1 };
    inst.volume = 1;
    if (inst.sid) {
      inst.sid.waveforms = ["saw"];
      inst.sid.filter = { cutoff, mode, resonance: 0, sweep: 0 };
    }
    const r = renderInstrumentNote(inst, 57, {
      chip: "c64",
      duration: 0.6,
      release: 0.1,
      sampleRate: SR,
    });
    const out = r.channels[0] ?? new Float32Array();
    return {
      high: bandEnergy(out, SR, 3000, 20_000, 9600, 16_384),
      low: bandEnergy(out, SR, 20, 300, 9600, 16_384),
    };
  }

  const dbBelow = (filtered: number, open: number) =>
    toDb(Math.sqrt(open / filtered));

  it("lp cuts the treble of the voice", () => {
    // cutoff 0.3 is about 180 Hz
    expect(
      dbBelow(bands("lp", 0.3).high, bands("off", 0.3).high)
    ).toBeGreaterThan(30);
  });

  it("hp cuts the bass of the voice", () => {
    // cutoff 0.8 is about 3.6 kHz
    expect(
      dbBelow(bands("hp", 0.8).low, bands("off", 0.8).low)
    ).toBeGreaterThan(30);
  });

  it("bp keeps the band around the cutoff and cuts the treble well above it", () => {
    // cutoff 0.2 is 100 Hz: the 220 Hz fundamental stays, the harmonics above 3 kHz go
    const open = bands("off", 0.2);
    const band = bands("bp", 0.2);
    expect(dbBelow(band.high, open.high)).toBeGreaterThan(20);
    expect(dbBelow(band.low, open.low)).toBeLessThan(10);
  });
});

describe("limiter", () => {
  /** A sine of the given amplitude through the limiter in 128 frame blocks, scaled per channel. */
  function limit(
    amp: (i: number) => number,
    n: number,
    [leftScale, rightScale] = [1, 0.7]
  ) {
    const lim = new Limiter(SR);
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      const v = amp(i) * Math.sin((2 * Math.PI * 220 * i) / SR);
      l[i] = v * leftScale;
      r[i] = v * rightScale;
    }
    for (let o = 0; o < n; o += 128) {
      lim.process(l.subarray(o, o + 128), r.subarray(o, o + 128), 128);
    }
    return { l, latency: lim.latency, r };
  }

  const peakOf = (a: Float32Array) =>
    a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it.each([
    ["left", [1, 0.7]],
    ["right", [0.7, 1]],
  ] as const)(
    "holds a +12 dB input at the -0.3 dBFS ceiling when the %s channel is the louder: never above it, and not far below it",
    (_, scales) => {
      const { l, r } = limit(() => 4, SR, [...scales]);
      const [loud, quiet] = scales[0] === 1 ? [l, r] : [r, l];
      expect(peakOf(loud)).toBeLessThanOrEqual(CEILING + 1e-6);
      expect(toDb(peakOf(loud))).toBeGreaterThan(-0.5);
      // the gain is shared by both channels, so the stereo image survives
      expect(peakOf(quiet) / peakOf(loud)).toBeCloseTo(0.7, 3);
    }
  );

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

  it("lets go of the gain over about 50 ms after a loud burst, neither snapping back nor lingering", () => {
    // 2000 frames at +9.5 dB over the ceiling, then a quiet 0.25 sine
    const { l, latency } = limit((i) => (i < 2000 ? 3 : 0.25), SR);
    const gainAt = (ms: number) => {
      const from = 2000 + latency + Math.round(ms * 48);
      let peak = 0;
      for (let i = from; i < from + 220; i += 1) {
        peak = Math.max(peak, Math.abs(l[i] ?? 0));
      }
      return peak / 0.25;
    };
    // an exponential release with a 50 ms time constant: about 0.76 of the way back after 50 ms
    expect(gainAt(10)).toBeLessThan(0.6);
    expect(gainAt(50)).toBeGreaterThan(0.65);
    expect(gainAt(50)).toBeLessThan(0.85);
    expect(gainAt(300)).toBeGreaterThan(0.98);
  });
});

describe("echo", () => {
  /** Send 2000 samples of noise through the echo and report the repeat found around each multiple of the delay. */
  function repeats(delay: number, feedback: number, level: number) {
    const echo = new Echo(SR);
    echo.configure(delay, feedback, level, 20_000);
    const n = SR;
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
    const energy = input.subarray(0, 2000).reduce((s, v) => s + v * v, 0);
    // least squares gain of the input inside the output at a lag
    const gainAt = (lag: number) => {
      let c = 0;
      for (let i = 0; i < 2000; i += 1) {
        c += (input[i] ?? 0) * (out[i + lag] ?? 0);
      }
      return c / energy;
    };
    const repeat = (k: number) => {
      const centre = Math.round(k * delay * SR);
      let best = { gain: -1, lag: 0 };
      for (let lag = centre - 10; lag <= centre + 10; lag += 1) {
        const gain = gainAt(lag);
        if (gain > best.gain) {
          best = { gain, lag };
        }
      }
      return best;
    };
    return { out, repeat };
  }

  it("repeats at the delay time (cross correlation peak), with nothing before it", () => {
    const { out, repeat } = repeats(0.1, 0.5, 1);
    const first = repeat(1);
    expect(Math.abs(first.lag - 0.1 * SR)).toBeLessThanOrEqual(2);
    // level 1 gives the input back, less a little for the one pole lowpass at 20 kHz
    expect(first.gain).toBeGreaterThan(0.85);
    expect(first.gain).toBeLessThan(1.05);
    for (let i = 0; i < 0.1 * SR - 10; i += 1) {
      expect(out[i]).toBe(0);
    }
  });

  it("feeds back: the second repeat is about the feedback times the first", () => {
    const { repeat } = repeats(0.1, 0.5, 1);
    const [first, second] = [repeat(1), repeat(2)];
    expect(Math.abs(second.lag - 0.2 * SR)).toBeLessThanOrEqual(2);
    expect(second.gain / first.gain).toBeGreaterThan(0.4);
    expect(second.gain / first.gain).toBeLessThan(0.55);
  });

  it("without feedback there is one repeat, and the level scales it", () => {
    const { repeat } = repeats(0.1, 0, 0.4);
    expect(repeat(1).gain).toBeGreaterThan(0.33);
    expect(repeat(1).gain).toBeLessThan(0.42);
    expect(Math.abs(repeat(2).gain)).toBeLessThan(0.02);
  });
});

describe("FM operators", () => {
  type Ops = NonNullable<Instrument["fm"]>["ops"];

  /**
   * Renders a custom chip FM note in which every operator sits parked at level 0 (far from the notes under test) with
   * a flat full envelope, then lets the test set up the ones it wants.
   */
  function renderFm(
    algorithm: number,
    setup: (ops: Ops) => void,
    note = 69,
    duration = 0.6
  ): Float32Array {
    const inst = defaultInstrument("fm");
    inst.envelope = { attack: 0, decay: 0.1, release: 0.05, sustain: 1 };
    if (inst.fm) {
      inst.fm.algorithm = algorithm;
      inst.fm.feedback = 0;
      inst.fm.lfo = null;
      for (const op of inst.fm.ops) {
        op.attack = 31;
        op.decay = 31;
        op.sustainRate = 0;
        op.sustainLevel = 1;
        op.waveform = 0;
        op.level = 0;
        op.mult = 15;
        op.fixedHz = null;
      }
      setup(inst.fm.ops);
    }
    const r = renderInstrumentNote(inst, note, {
      chip: "custom",
      duration,
      release: 0.05,
      sampleRate: SR,
    });
    return r.channels[0] ?? new Float32Array();
  }

  /** One carrier (operator 1 on the all-carrier algorithm) at A-4. */
  function carrier(level: number, sustainLevel: number): Float32Array {
    return renderFm(7, (ops) => {
      const [first] = ops;
      if (first) {
        first.mult = 1;
        first.level = level;
        first.sustainLevel = sustainLevel;
      }
    });
  }

  it("operator level is a linear amplitude: 0.5 is 6 dB down, 0.25 is 12 dB down", () => {
    const full = rms(carrier(1, 1), 14_400, 24_000);
    expect(toDb(rms(carrier(0.5, 1), 14_400, 24_000) / full)).toBeCloseTo(
      -6.02,
      0
    );
    expect(toDb(rms(carrier(0.25, 1), 14_400, 24_000) / full)).toBeCloseTo(
      -12.04,
      0
    );
  });

  it("the sustain level is a linear amplitude too: a decay that stops at 0.25 settles 12 dB down", () => {
    const flat = rms(carrier(1, 1), 14_400, 24_000);
    const settled = rms(carrier(1, 0.25), 14_400, 24_000);
    expect(toDb(settled / flat)).toBeCloseTo(-12.04, 0);
  });

  // Operator 1 modulates operator 2 (algorithm 4) at three times its frequency. With a modulation index b the
  // spectrum has lines at 440 * (1 + 3 n) Hz of amplitude |J_n(b)|: 440 Hz holds J0 and 1760 Hz holds J1 and no other
  // term. An operator at level 1 modulates by 8 radians, at level 0.5 by 4 and at level 0.25 by 2 (architecture 3.5).
  it.each([
    [1, 8, 0.171_651, 0.234_636],
    [0.5, 4, -0.397_15, -0.066_043],
    [0.25, 2, 0.223_891, 0.576_725],
  ])(
    "an operator at level %f modulates by %i radians: the 1760 Hz line over the 440 Hz line is J1/J0",
    (level, _index, j0, j1) => {
      const out = renderFm(4, (ops) => {
        const [mod, car] = ops;
        if (mod && car) {
          mod.mult = 3;
          mod.level = level;
          car.mult = 1;
          car.level = 1;
        }
      });
      const line = (hz: number) =>
        Math.sqrt(bandEnergy(out, SR, hz - 40, hz + 40, 4800, 16_384));
      const ratio = line(1760) / line(440);
      expect(Math.abs(ratio / Math.abs(j1 / j0) - 1)).toBeLessThan(0.03);
    }
  );

  describe("envelope rates", () => {
    /** A carrier at a fixed 440 Hz on key 12 (key scaling adds nothing there), decaying toward the floor at `rate`. */
    function decaying(rate: number): Float32Array {
      return renderFm(
        7,
        (ops) => {
          const [first] = ops;
          if (first) {
            first.fixedHz = 440;
            first.level = 1;
            first.decay = rate;
            first.sustainLevel = 0;
          }
        },
        12,
        0.8
      );
    }

    /** The dB between two 50 ms windows of the render (negative when the second is quieter). */
    function dropDb(out: Float32Array, from: number, to: number): number {
      const win = (t: number) =>
        rms(out, Math.round(t * SR), Math.round((t + 0.05) * SR));
      return toDb(win(to) / win(from));
    }

    it("every 2.5 steps of rate halve the time a decay takes, so 5 steps more is four times as steep", () => {
      // the envelope falls linearly in dB, so a slope is the drop over the time between two windows
      const slow = dropDb(decaying(5), 0.1, 0.5) / 0.4;
      const fast = dropDb(decaying(10), 0.02, 0.22) / 0.2;
      expect(slow).toBeLessThan(-30);
      expect(fast / slow).toBeCloseTo(4, 1);
    });

    it("rate 0 never moves", () => {
      expect(Math.abs(dropDb(decaying(0), 0.1, 0.5))).toBeLessThan(0.1);
    });
  });
});

describe("note frequencies", () => {
  it("noteToHz follows the MIDI table: A-4 is 440 Hz and every octave doubles it", () => {
    expect(noteToHz(69)).toBe(440);
    expect(noteToHz(81)).toBeCloseTo(880, 9);
    expect(noteToHz(57)).toBeCloseTo(220, 9);
    // middle C and the lowest piano key, from the standard table
    expect(noteToHz(60)).toBeCloseTo(261.6256, 3);
    expect(noteToHz(21)).toBeCloseTo(27.5, 9);
  });
});
