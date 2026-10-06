/* The calm display for a channel scope whose sound has no period: noise, or anything the trigger cannot lock to. A
   noise wave redraws completely every frame whatever the trigger does, so instead of the wave the scope shows a fixed
   texture (a mirrored bar profile that never changes) scaled by the channel's level, smoothed with the spectrum's
   ballistics (bands.ts): a drum hit pulses it up fast, and it falls at a steady rate, so nothing shimmers or scrolls. */
import { fallDb, riseFactor, SILENT_PEAK } from "./bands.ts";

/** Frames of sound the level is read from: the newest 2048, about 43 ms at 48 kHz. */
export const LEVEL_FRAMES = 2048;
/** The scale in dB RMS: a full-scale square reads 0 dB, the floor is an empty display. */
const LEVEL_TOP_DB = 0;
export const LEVEL_FLOOR_DB = -36;
/** Lowest height of a column (a fraction of the tallest): the texture only trims columns, it never empties them. */
const TEXTURE_MIN = 0.5;
/** Frames in a row without a period before a pitched channel switches to the level display, and with one before it
    switches back (about 130 ms and 65 ms at 60 fps): a flicker of detection does not flip the picture. */
export const LEVEL_ENTER_FRAMES = 8;
export const LEVEL_LEAVE_FRAMES = 4;

export interface LevelState {
  /** The smoothed level in dB. */
  db: number;
  /** Scratch: the half-height in pixels of each column, set by columnHeights. */
  heights: Int32Array;
  /** Each column's share of the height, TEXTURE_MIN..1, fixed for the life of the state. */
  texture: Float32Array;
}

/** A fixed texture: seeded values, blurred across neighbours so the profile reads as a landscape, not as static. */
export function createTexture(columns: number): Float32Array {
  const raw = new Float32Array(columns);
  let seed = 48_271;
  for (let c = 0; c < columns; c += 1) {
    // Park-Miller: exact in a double, and the same texture every time
    seed = (seed * 16_807) % 2_147_483_647;
    raw[c] = seed / 2_147_483_647;
  }
  const out = new Float32Array(columns);
  let top = 0;
  for (let c = 0; c < columns; c += 1) {
    const a = raw[Math.max(0, c - 1)] ?? 0;
    const b = raw[c] ?? 0;
    const d = raw[Math.min(columns - 1, c + 1)] ?? 0;
    out[c] = (a + 2 * b + d) / 4;
    top = Math.max(top, out[c] ?? 0);
  }
  for (let c = 0; c < columns; c += 1) {
    out[c] = TEXTURE_MIN + (1 - TEXTURE_MIN) * ((out[c] ?? 0) / (top || 1));
  }
  return out;
}

export function createLevelState(columns: number): LevelState {
  return {
    db: LEVEL_FLOOR_DB,
    heights: new Int32Array(columns),
    texture: createTexture(columns),
  };
}

/** The RMS level of the newest LEVEL_FRAMES frames of `data`, in dB (the floor for silence). */
export function levelDb(data: Float32Array): number {
  const n = Math.min(LEVEL_FRAMES, data.length);
  let energy = 0;
  for (let i = data.length - n; i < data.length; i += 1) {
    const v = data[i] ?? 0;
    energy += v * v;
  }
  const rms = Math.sqrt(energy / Math.max(1, n));
  return rms < 1e-6
    ? LEVEL_FLOOR_DB
    : Math.max(LEVEL_FLOOR_DB, Math.min(LEVEL_TOP_DB, 20 * Math.log10(rms)));
}

/**
 * One step of `dt` seconds towards `target` dB: a rise with the attack time constant, a fall at the release rate
 * (the fast stop fall once the channel is `silent`).
 */
function stepLevel(
  s: LevelState,
  target: number,
  dt: number,
  silent = false
): void {
  s.db =
    target > s.db
      ? s.db + (target - s.db) * riseFactor(dt)
      : Math.max(target, s.db - fallDb(dt, silent));
}

/** Read `data` (the channel's newest sound, whose peak is `peak`) into the display for a step of `dt` seconds. */
export function updateLevel(
  s: LevelState,
  data: Float32Array,
  dt: number,
  peak: number
): void {
  stepLevel(s, levelDb(data), dt, peak < SILENT_PEAK);
}

/** 0..1 height of a level in dB. */
function levelFraction(db: number): number {
  const t = (db - LEVEL_FLOOR_DB) / (LEVEL_TOP_DB - LEVEL_FLOOR_DB);
  return Math.max(0, Math.min(1, t));
}

/** Fill `s.heights` with the half-height in pixels of each column, `reach` pixels from the middle at full level. */
export function columnHeights(s: LevelState, reach: number): Int32Array {
  const level = levelFraction(s.db) * reach;
  for (let c = 0; c < s.heights.length; c += 1) {
    s.heights[c] = Math.round(level * (s.texture[c] ?? 1));
  }
  return s.heights;
}

export interface ModeState {
  /** Frames in a row with a period. */
  found: number;
  /** True while the channel shows the level display. */
  level: boolean;
  /** Frames in a row without one. */
  lost: number;
}

export function createMode(): ModeState {
  return { found: 0, level: false, lost: 0 };
}

/**
 * Whether a channel draws the level display this frame. A noise channel always does, and never needs a period. Any
 * other one does after LEVEL_ENTER_FRAMES frames without a detectable `period` and goes back to the wave after
 * LEVEL_LEAVE_FRAMES with one. A silent frame (a rest) changes nothing: the next note starts in the picture the
 * last one ended in.
 */
export function levelMode(
  m: ModeState,
  noise: boolean,
  period: number,
  silent: boolean
): boolean {
  if (noise) {
    m.level = true;
    return true;
  }
  if (silent) {
    return m.level;
  }
  if (period > 0) {
    m.found += 1;
    m.lost = 0;
    if (m.level && m.found >= LEVEL_LEAVE_FRAMES) {
      m.level = false;
    }
  } else {
    m.lost += 1;
    m.found = 0;
    if (!m.level && m.lost >= LEVEL_ENTER_FRAMES) {
      m.level = true;
    }
  }
  return m.level;
}
