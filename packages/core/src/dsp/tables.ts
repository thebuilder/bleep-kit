// biome-ignore-all lint/suspicious/noBitwiseOperators: DSP code: LFSR shifts, power-of-two ring masks, integer hashing and flag masks need bit operations
/* Lookup tables, built lazily once (section 3.11). Table construction may use Math.sin and Math.exp; the hot path never does. */

export const SINE_SIZE = 4096;

let sine: Float32Array | null = null;
let dbAmp: Float32Array | null = null;
let triNes: Float32Array | null = null;
const logQuant = new Map<string, Float32Array>();

/** One sine cycle in SINE_SIZE steps plus a guard point, so linear interpolation never wraps. */
export function sineTable(): Float32Array {
  if (!sine) {
    sine = new Float32Array(SINE_SIZE + 1);
    for (let i = 0; i <= SINE_SIZE; i += 1) {
      sine[i] = Math.sin((2 * Math.PI * i) / SINE_SIZE);
    }
  }
  return sine;
}

/** Sine of a phase in cycles (0 to 1, wrapped by the caller), linearly interpolated. */
export function sinCycles(table: Float32Array, phase: number): number {
  const p = phase * SINE_SIZE;
  const i = Math.floor(p);
  const frac = p - i;
  const a = table[i & (SINE_SIZE - 1)] ?? 0;
  const b = table[(i & (SINE_SIZE - 1)) + 1] ?? 0;
  return a + (b - a) * frac;
}

export const DB_RES = 16;
export const DB_MAX = 144;

/** Attenuation in dB (index = dB * DB_RES) to linear amplitude. */
export function dbAmpTable(): Float32Array {
  if (!dbAmp) {
    dbAmp = new Float32Array(DB_MAX * DB_RES + 1);
    for (let i = 0; i < dbAmp.length; i += 1) {
      dbAmp[i] = 10 ** (-i / DB_RES / 20);
    }
    dbAmp[dbAmp.length - 1] = 0;
  }
  return dbAmp;
}

/** Linear amplitude for an attenuation in dB (0 or more); 0 beyond the table. */
export function dbToAmp(table: Float32Array, db: number): number {
  if (db <= 0) {
    return 1;
  }
  const i = db * DB_RES;
  if (i >= table.length - 1) {
    return 0;
  }
  const k = Math.floor(i);
  const f = i - k;
  const a = table[k] ?? 0;
  const b = table[k + 1] ?? 0;
  return a + (b - a) * f;
}

/** The NES triangle sequence: 15 down to 0 then 0 up to 15, as bipolar values (-1 to 1). */
export function nesTriangleTable(): Float32Array {
  if (!triNes) {
    triNes = new Float32Array(32);
    for (let i = 0; i < 16; i += 1) {
      triNes[i] = (15 - i) / 7.5 - 1;
      triNes[16 + i] = i / 7.5 - 1;
    }
  }
  return triNes;
}

export const QUANT_RES = 4096;

/** Amplitude quantizer for log-stepped volume chips (PSG 2 dB, YM and OPL 0.75 dB). Index = amplitude * QUANT_RES. */
export function logQuantTable(stepDb: number, steps: number): Float32Array {
  const key = `${stepDb}|${steps}`;
  let t = logQuant.get(key);
  if (!t) {
    t = new Float32Array(QUANT_RES + 1);
    const kmax = steps - 2;
    for (let i = 0; i <= QUANT_RES; i += 1) {
      const a = i / QUANT_RES;
      if (a <= 0) {
        t[i] = 0;
        continue;
      }
      const k = Math.round((-20 * Math.log10(a)) / stepDb);
      t[i] = k > kmax ? 0 : 10 ** ((-k * stepDb) / 20);
    }
    logQuant.set(key, t);
  }
  return t;
}

/** OPL waveform select (0 to 7) evaluated at a phase in cycles (0 to 1). Returns -1 to 1. */
export function oplWave(
  table: Float32Array,
  waveform: number,
  phase: number
): number {
  const s = sinCycles(table, phase);
  switch (waveform) {
    case 1:
      return s > 0 ? s : 0;
    case 2:
      return Math.abs(s);
    case 3: {
      const q = phase * 4;
      return q % 2 < 1 ? Math.abs(s) : 0;
    }
    case 4:
      return phase < 0.5 ? sinCycles(table, (phase * 2) % 1) : 0;
    case 5:
      return phase < 0.5 ? Math.abs(sinCycles(table, (phase * 2) % 1)) : 0;
    case 6:
      return phase < 0.5 ? 1 : -1;
    case 7: {
      const m = Math.abs(s) ** 0.25;
      return phase < 0.5 ? m : -m;
    }
    default:
      return s;
  }
}
