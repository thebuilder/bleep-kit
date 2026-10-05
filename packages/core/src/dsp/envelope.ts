/* Amplitude envelope: linear attack, exponential decay and release (coefficient per sample, precomputed when the
   stage starts). Tiny minimum times keep note starts and stops from clicking. */

export const ENV_IDLE = 0;
const ENV_ATTACK = 1;
const ENV_DECAY = 2;
export const ENV_SUSTAIN = 3;
const ENV_RELEASE = 4;

/** Shortest attack and release (seconds): a declick ramp. */
export const MIN_ATTACK = 0.0006;
const MIN_RELEASE = 0.0012;
const MIN_DECAY = 0.001;
const FLOOR = 1e-5;
/** -60 dB: a decay or release time is when the level has fallen to this fraction. */
const SIXTY_DB = 0.001;

export interface EnvelopeState {
  attackInc: number;
  decayCoef: number;
  /** Frames of the last run up to and including the one where the envelope fell idle, or -1 when it did not. */
  idleAt: number;
  level: number;
  releaseCoef: number;
  stage: number;
  sustain: number;
}

export function newEnvelope(): EnvelopeState {
  return {
    attackInc: 1,
    decayCoef: 0.99,
    idleAt: -1,
    level: 0,
    releaseCoef: 0.99,
    stage: ENV_IDLE,
    sustain: 1,
  };
}

export function setEnvelopeParams(
  e: EnvelopeState,
  attack: number,
  decay: number,
  sustain: number,
  release: number,
  sampleRate: number
): void {
  e.attackInc = 1 / (Math.max(attack, MIN_ATTACK) * sampleRate);
  e.decayCoef = SIXTY_DB ** (1 / (Math.max(decay, MIN_DECAY) * sampleRate));
  e.sustain = sustain;
  e.releaseCoef =
    SIXTY_DB ** (1 / (Math.max(release, MIN_RELEASE) * sampleRate));
}

/** Start a note. The level is kept, so a retrigger on a sounding voice ramps up from where it is. */
export function envelopeTrigger(e: EnvelopeState): void {
  e.stage = ENV_ATTACK;
}

export function envelopeRelease(e: EnvelopeState): void {
  if (e.stage !== ENV_IDLE) {
    e.stage = ENV_RELEASE;
  }
}

/** Write the level for each of n samples. Returns true while the envelope is still producing sound. */
export function runEnvelope(
  e: EnvelopeState,
  out: Float32Array,
  n: number
): void {
  let level = e.level;
  let stage = e.stage;
  const sustain = e.sustain;
  e.idleAt = -1;
  for (let i = 0; i < n; i += 1) {
    switch (stage) {
      case ENV_ATTACK:
        level += e.attackInc;
        if (level >= 1) {
          level = 1;
          stage = ENV_DECAY;
        }
        break;
      case ENV_DECAY:
        level = sustain + (level - sustain) * e.decayCoef;
        if (level - sustain < 1e-4 && level >= sustain) {
          level = sustain;
          stage = ENV_SUSTAIN;
        } else if (level < sustain) {
          level = sustain;
          stage = ENV_SUSTAIN;
        }
        break;
      case ENV_RELEASE:
        level *= e.releaseCoef;
        if (level < FLOOR) {
          level = 0;
          stage = ENV_IDLE;
          e.idleAt = i + 1;
        }
        break;
      default:
        break;
    }
    out[i] = level;
  }
  e.level = level;
  e.stage = stage;
}
