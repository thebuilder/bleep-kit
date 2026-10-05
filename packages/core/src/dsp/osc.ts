// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
/* Oscillators: PolyBLEP pulse, and naive triangle, saw, sine and wavetable (aliasing is part of the sound, section 3.3).
   Each renderer fills out[0..n) and advances the shared phase state. Phase is in cycles. */

import { sinCycles } from "./tables.ts";

export interface PhaseState {
  /** Phase increment per sample (frequency / sample rate), already clamped below Nyquist. */
  dt: number;
  phase: number;
}

export function newPhase(): PhaseState {
  return { dt: 0, phase: 0 };
}

export const MAX_DT = 0.45;

export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/** Band-limited pulse with the given duty (0 to 1). */
export function renderPulse(
  s: PhaseState,
  duty: number,
  out: Float32Array,
  n: number
): void {
  let phase = s.phase;
  const dt = s.dt;
  const d = Math.min(0.98, Math.max(0.02, duty));
  for (let i = 0; i < n; i += 1) {
    let v = phase < d ? 1 : -1;
    v += polyBlep(phase, dt);
    let t2 = phase + 1 - d;
    if (t2 >= 1) {
      t2 -= 1;
    }
    v -= polyBlep(t2, dt);
    out[i] = v;
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  s.phase = phase;
}

/** Clean triangle, naive. */
export function renderTriangle(
  s: PhaseState,
  out: Float32Array,
  n: number
): void {
  let phase = s.phase;
  const dt = s.dt;
  for (let i = 0; i < n; i += 1) {
    out[i] = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  s.phase = phase;
}

/** Stepped waveform from a table of bipolar values (NES triangle: 32 steps, Game Boy wave: 32 steps). */
export function renderStepped(
  s: PhaseState,
  table: Float32Array,
  out: Float32Array,
  n: number
): void {
  let phase = s.phase;
  const dt = s.dt;
  const len = table.length;
  for (let i = 0; i < n; i += 1) {
    out[i] = table[Math.floor(phase * len)] ?? 0;
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  s.phase = phase;
}

/** Naive rising saw. */
export function renderSaw(s: PhaseState, out: Float32Array, n: number): void {
  let phase = s.phase;
  const dt = s.dt;
  for (let i = 0; i < n; i += 1) {
    out[i] = 2 * phase - 1;
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  s.phase = phase;
}

export function renderSine(
  s: PhaseState,
  table: Float32Array,
  out: Float32Array,
  n: number
): void {
  let phase = s.phase;
  const dt = s.dt;
  for (let i = 0; i < n; i += 1) {
    out[i] = sinCycles(table, phase);
    phase += dt;
    if (phase >= 1) {
      phase -= 1;
    }
  }
  s.phase = phase;
}
