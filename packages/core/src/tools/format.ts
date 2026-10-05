/* Small text helpers shared by the analysis output, the images and the CLI. */

/** Quietest level any measurement reports; silence is -120 instead of -Infinity so JSON stays valid. */
export const DB_FLOOR = -120;

const NOTE_LABELS = [
  "C-",
  "C#",
  "D-",
  "D#",
  "E-",
  "F-",
  "F#",
  "G-",
  "G#",
  "A-",
  "A#",
  "B-",
] as const;

/** Format a duration in seconds: "310 ms", "2.50 s", "1:05.2". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "-";
  }
  const s = Math.max(0, seconds);
  if (s < 1) {
    return `${Math.round(s * 1000)} ms`;
  }
  if (s < 60) {
    return `${s.toFixed(2)} s`;
  }
  const minutes = Math.floor(s / 60);
  const rest = s - minutes * 60;
  const whole = rest.toFixed(1).padStart(4, "0");
  return `${minutes}:${whole}`;
}

/** Format a level in dB with one decimal; anything at or below the floor reads "-inf dB". */
export function formatDb(db: number, digits = 1): string {
  if (Number.isNaN(db) || db <= DB_FLOOR) {
    return "-inf dB";
  }
  const text = db.toFixed(digits);
  return `${text === "-0.0" ? "0.0" : text} dB`;
}

/** Linear amplitude (0..1 full scale) to dB, floored at DB_FLOOR. */
export function ampToDb(amp: number): number {
  if (!(amp > 0)) {
    return DB_FLOOR;
  }
  return Math.max(DB_FLOOR, 20 * Math.log10(amp));
}

/** Mean square (power) to dB, floored at DB_FLOOR. */
export function powerToDb(power: number): number {
  if (!(power > 0)) {
    return DB_FLOOR;
  }
  return Math.max(DB_FLOOR, 10 * Math.log10(power));
}

/** Nearest note name for a frequency, in the contract spelling (69 = A-4 = 440 Hz, 60 = C-4). */
export function hzToNoteName(hz: number): string | null {
  if (!(hz > 0)) {
    return null;
  }
  const note = Math.round(69 + 12 * Math.log2(hz / 440));
  const octave = Math.floor(note / 12) - 1;
  const label = NOTE_LABELS[((note % 12) + 12) % 12] ?? "C-";
  return `${label}${octave}`;
}

/** Round to a number of decimals (for tidy JSON). */
export function round(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
