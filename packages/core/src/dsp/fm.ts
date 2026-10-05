/* FM synthesis (section 3.5): 2 or 4 operators with YM style rate envelopes in dB, OPL waveform select, feedback on
   operator 1 and the eight YM2612 algorithms. */

import type { FmPatch } from "../types.ts";
import {
  dbAmpTable,
  dbToAmp,
  oplWave,
  sinCycles,
  sineTable,
} from "./tables.ts";

/** An operator at level 1 modulates by this many radians (the contract pins it). */
export const MOD_INDEX = 8;
const TWO_PI = 2 * Math.PI;
const FULL_DB = 96;
/** Makeup gain: a lone full level carrier peaks at 1, so FM voices sit near the pulses before the chip gain. */
const FM_MAKEUP = 1;
/** Sustain level 0 means this much attenuation (and so does anything quieter). */
const SUSTAIN_RANGE_DB = 48;
/** Levels below this are treated as silent (-100 dB): keeps the dB conversion finite. */
const MIN_LEVEL = 1e-5;

/** Attenuation in dB of a linear amplitude level (1 = 0 dB, 0.5 = 6 dB), capped at `max`. */
function levelToDb(level: number, max: number): number {
  return Math.min(max, -20 * Math.log10(Math.max(MIN_LEVEL, level)));
}

const OP_OFF = 0;
const OP_ATTACK = 1;
const OP_DECAY = 2;
const OP_SUSTAIN = 3;
const OP_RELEASE = 4;

/** Seconds a rate takes to cover the full range: 10 * 2^(-rate / 2.5). Rate 0 never moves. */
export function rateSeconds(rate: number): number {
  return 10 * 2 ** (-rate / 2.5);
}

export interface FmOpRt {
  attackRate: number;
  decayRate: number;
  detuneCents: number;
  fixedHz: number;
  keyScale: number;
  mult: number;
  releaseRate: number;
  sustainDb: number;
  sustainRate: number;
  tlDb: number;
  waveform: number;
}

export interface FmRt {
  algorithm: number;
  feedback: number;
  lfoAmp: number;
  lfoPitchCents: number;
  lfoRate: number;
  nOps: 2 | 4;
  ops: FmOpRt[];
  waveforms: boolean;
}

/** Compile a patch for a chip. patchOps is the number of operators the chip runs (2 or 4). */
export function compileFmPatch(
  patch: FmPatch,
  chipOps: 2 | 4 | null,
  waveforms: boolean
): FmRt {
  const own = patch.ops.length === 4 ? 4 : 2;
  const nOps = chipOps ?? own;
  const ops: FmOpRt[] = [];
  for (let i = 0; i < nOps; i += 1) {
    const o = patch.ops[i];
    if (!o) {
      ops.push({
        attackRate: 31,
        decayRate: 0,
        detuneCents: 0,
        fixedHz: 0,
        keyScale: 0,
        mult: 1,
        releaseRate: 15,
        sustainDb: 0,
        sustainRate: 0,
        tlDb: FULL_DB,
        waveform: 0,
      });
      continue;
    }
    ops.push({
      attackRate: o.attack,
      decayRate: o.decay,
      detuneCents: o.detune * 5,
      fixedHz: o.fixedHz ?? 0,
      keyScale: o.keyScale,
      mult: o.mult === 0 ? 0.5 : o.mult,
      releaseRate: o.release * 2 + 1,
      sustainDb: levelToDb(o.sustainLevel, SUSTAIN_RANGE_DB),
      sustainRate: o.sustainRate,
      tlDb: levelToDb(o.level, FULL_DB),
      waveform: waveforms ? o.waveform : 0,
    });
  }
  let algorithm = patch.algorithm;
  if (own === 4 && nOps === 2) {
    algorithm = Math.min(algorithm, 1);
  } else if (own === 2 && nOps === 4) {
    algorithm = algorithm === 0 ? 4 : 7;
  }
  return {
    algorithm,
    feedback: patch.feedback,
    lfoAmp: patch.lfo?.ampDepth ?? 0,
    lfoPitchCents: patch.lfo?.pitchDepth ?? 0,
    lfoRate: patch.lfo?.rate ?? 0,
    nOps,
    ops,
    waveforms,
  };
}

export interface FmState {
  algorithm: number;
  ampDb: number;
  att: Float64Array;
  attackCoef: Float64Array;
  baseHz: number;
  decayStep: Float64Array;
  fbRad: number;
  inc: Float64Array;
  lfoPhase: number;
  lfoPitch: number;
  nOps: number;
  note: number;
  out1: Float64Array;
  out2: Float64Array;
  outScale: number;
  phase: Float64Array;
  releaseStep: Float64Array;
  sampleRate: number;
  stage: Uint8Array;
  sustainDb: Float64Array;
  sustainStep: Float64Array;
  tl: Float64Array;
  wave: Uint8Array;
}

export function newFmState(sampleRate: number): FmState {
  return {
    algorithm: 0,
    ampDb: 0,
    att: new Float64Array(4).fill(FULL_DB),
    attackCoef: new Float64Array(4),
    baseHz: 440,
    decayStep: new Float64Array(4),
    fbRad: 0,
    inc: new Float64Array(4),
    lfoPhase: 0,
    lfoPitch: 0,
    nOps: 4,
    note: 60,
    out1: new Float64Array(4),
    out2: new Float64Array(4),
    outScale: 1,
    phase: new Float64Array(4),
    releaseStep: new Float64Array(4),
    sampleRate,
    stage: new Uint8Array(4),
    sustainDb: new Float64Array(4),
    sustainStep: new Float64Array(4),
    tl: new Float64Array(4),
    wave: new Uint8Array(4),
  };
}

function keyCode(note: number): number {
  return Math.min(31, Math.max(0, Math.round(((note - 12) * 31) / 96)));
}

/** Number of carrier operators per algorithm, used to keep the output level comparable between patches. */
const CARRIERS_4 = [1, 1, 1, 1, 2, 3, 3, 4] as const;

function stepFor(rate: number, sr: number): number {
  return rate <= 0 ? 0 : FULL_DB / (rateSeconds(rate) * sr);
}

export function fmSetAlgorithm(s: FmState, rt: FmRt, algorithm: number): void {
  const max = rt.nOps === 4 ? 7 : 1;
  s.algorithm = Math.min(max, Math.max(0, algorithm));
  const carriers =
    rt.nOps === 4 ? (CARRIERS_4[s.algorithm] ?? 1) : s.algorithm === 0 ? 1 : 2;
  s.outScale = FM_MAKEUP / Math.sqrt(carriers);
}

/**
 * Key on: set rates for this note and start every attack. Phases, feedback memory and envelope levels restart, so a note
 * sounds the same whatever the voice played before it (the voice hides the step on a voice that is still sounding);
 * without that, a looped song's second pass would differ from its first and the loop would click at the seam.
 */
export function fmNoteOn(s: FmState, rt: FmRt, note: number): void {
  const sr = s.sampleRate;
  s.nOps = rt.nOps;
  s.note = note;
  s.phase.fill(0);
  s.out1.fill(0);
  s.out2.fill(0);
  s.att.fill(FULL_DB);
  s.lfoPitch = 0;
  const kc = keyCode(note);
  for (let i = 0; i < rt.nOps; i += 1) {
    const o = rt.ops[i];
    if (!o) {
      continue;
    }
    const scale = (kc >> (3 - o.keyScale)) / 2;
    const ar = o.attackRate <= 0 ? 0 : Math.min(31, o.attackRate + scale);
    const dr = o.decayRate <= 0 ? 0 : Math.min(31, o.decayRate + scale);
    const sr2 = o.sustainRate <= 0 ? 0 : Math.min(31, o.sustainRate + scale);
    const rr = Math.min(31, o.releaseRate + scale);
    s.attackCoef[i] =
      ar <= 0 ? 1 : Math.exp(-Math.log(FULL_DB * 10) / (rateSeconds(ar) * sr));
    s.decayStep[i] = stepFor(dr, sr);
    s.sustainStep[i] = stepFor(sr2, sr);
    s.releaseStep[i] = stepFor(rr, sr);
    s.sustainDb[i] = o.sustainDb;
    s.tl[i] = o.tlDb;
    s.wave[i] = o.waveform;
    s.stage[i] = ar <= 0 ? OP_OFF : OP_ATTACK;
    if (s.att[i] === undefined || (s.att[i] ?? FULL_DB) < 0) {
      s.att[i] = FULL_DB;
    }
  }
  fmSetAlgorithm(s, rt, rt.algorithm);
  s.fbRad = rt.feedback === 0 ? 0 : 2 ** (rt.feedback - 7) * Math.PI;
}

export function fmNoteOff(s: FmState): void {
  for (let i = 0; i < s.nOps; i += 1) {
    if (s.stage[i] !== OP_OFF) {
      s.stage[i] = OP_RELEASE;
    }
  }
}

/** True when every operator has faded out. */
export function fmSilent(s: FmState): boolean {
  for (let i = 0; i < s.nOps; i += 1) {
    if (s.stage[i] !== OP_OFF) {
      return false;
    }
  }
  return true;
}

/** Set the pitch (fundamental in Hz) for all operators. cents adds the LFO. */
export function fmSetPitch(
  s: FmState,
  rt: FmRt,
  hz: number,
  cents: number
): void {
  s.baseHz = hz;
  const sr = s.sampleRate;
  for (let i = 0; i < rt.nOps; i += 1) {
    const o = rt.ops[i];
    if (!o) {
      continue;
    }
    const f =
      o.fixedHz > 0
        ? o.fixedHz
        : hz * o.mult * 2 ** ((o.detuneCents + cents) / 1200);
    s.inc[i] = Math.min(0.49, f / sr);
  }
}

export function fmReset(s: FmState): void {
  s.phase.fill(0);
  s.out1.fill(0);
  s.out2.fill(0);
  s.att.fill(FULL_DB);
  s.stage.fill(OP_OFF);
  s.lfoPhase = 0;
}

function opStep(
  s: FmState,
  i: number,
  mod: number,
  sine: Float32Array,
  db: Float32Array
): number {
  // envelope (attenuation in dB)
  let att = s.att[i] ?? FULL_DB;
  switch (s.stage[i]) {
    case OP_ATTACK:
      att *= s.attackCoef[i] ?? 1;
      if (att < 0.08) {
        att = 0;
        s.stage[i] = OP_DECAY;
      }
      break;
    case OP_DECAY: {
      att += s.decayStep[i] ?? 0;
      const target = s.sustainDb[i] ?? 0;
      if (att >= target) {
        att = target;
        s.stage[i] = OP_SUSTAIN;
      }
      break;
    }
    case OP_SUSTAIN:
      att += s.sustainStep[i] ?? 0;
      if (att >= FULL_DB) {
        att = FULL_DB;
        s.stage[i] = OP_OFF;
      }
      break;
    case OP_RELEASE:
      att += s.releaseStep[i] ?? 0;
      if (att >= FULL_DB) {
        att = FULL_DB;
        s.stage[i] = OP_OFF;
      }
      break;
    default:
      break;
  }
  s.att[i] = att;
  // phase
  let ph = (s.phase[i] ?? 0) + mod * (MOD_INDEX / TWO_PI);
  ph -= Math.floor(ph);
  const w = s.wave[i] ?? 0;
  const raw = w === 0 ? sinCycles(sine, ph) : oplWave(sine, w, ph);
  let p = (s.phase[i] ?? 0) + (s.inc[i] ?? 0);
  if (p >= 1) {
    p -= 1;
  }
  s.phase[i] = p;
  if (s.stage[i] === OP_OFF) {
    return 0;
  }
  const total = (s.tl[i] ?? 0) + att;
  const out = raw * dbToAmp(db, total);
  return out;
}

/** Render n samples of the carriers' sum into out. ampLevel scales the voice (envelope and volume are applied by the voice). */
export function renderFm(s: FmState, out: Float32Array, n: number): void {
  const sine = sineTable();
  const db = dbAmpTable();
  const alg = s.algorithm;
  const fb = s.fbRad / TWO_PI;
  const four = s.nOps === 4;
  const scale = s.outScale;
  for (let k = 0; k < n; k += 1) {
    const f =
      fb === 0
        ? 0
        : (((s.out1[0] ?? 0) + (s.out2[0] ?? 0)) * 0.5 * s.fbRad) / MOD_INDEX;
    const o1 = opStep(s, 0, f, sine, db);
    s.out2[0] = s.out1[0] ?? 0;
    s.out1[0] = o1;
    let y: number;
    if (four) {
      switch (alg) {
        case 0: {
          const o2 = opStep(s, 1, o1, sine, db);
          const o3 = opStep(s, 2, o2, sine, db);
          y = opStep(s, 3, o3, sine, db);
          break;
        }
        case 1: {
          const o2 = opStep(s, 1, 0, sine, db);
          const o3 = opStep(s, 2, o1 + o2, sine, db);
          y = opStep(s, 3, o3, sine, db);
          break;
        }
        case 2: {
          const o2 = opStep(s, 1, 0, sine, db);
          const o3 = opStep(s, 2, o2, sine, db);
          y = opStep(s, 3, o1 + o3, sine, db);
          break;
        }
        case 3: {
          const o2 = opStep(s, 1, o1, sine, db);
          const o3 = opStep(s, 2, 0, sine, db);
          y = opStep(s, 3, o2 + o3, sine, db);
          break;
        }
        case 4: {
          const o2 = opStep(s, 1, o1, sine, db);
          const o3 = opStep(s, 2, 0, sine, db);
          y = o2 + opStep(s, 3, o3, sine, db);
          break;
        }
        case 5: {
          const o2 = opStep(s, 1, o1, sine, db);
          const o3 = opStep(s, 2, o1, sine, db);
          y = o2 + o3 + opStep(s, 3, o1, sine, db);
          break;
        }
        case 6: {
          const o2 = opStep(s, 1, o1, sine, db);
          const o3 = opStep(s, 2, 0, sine, db);
          y = o2 + o3 + opStep(s, 3, 0, sine, db);
          break;
        }
        default: {
          const o2 = opStep(s, 1, 0, sine, db);
          const o3 = opStep(s, 2, 0, sine, db);
          y = o1 + o2 + o3 + opStep(s, 3, 0, sine, db);
          break;
        }
      }
    } else if (alg === 0) {
      y = opStep(s, 1, o1, sine, db);
    } else {
      y = o1 + opStep(s, 1, 0, sine, db);
    }
    out[k] = y * scale;
  }
}
