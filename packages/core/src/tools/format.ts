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

/** Format a duration in seconds: "310 ms", "2.50 s", "1:05.2". Rounds first, then picks the unit. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    return "-";
  }
  const s = Math.max(0, seconds);
  const ms = Math.round(s * 1000);
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const centis = Math.round(s * 100);
  if (centis < 6000) {
    return `${(centis / 100).toFixed(2)} s`;
  }
  // whole tenths of a second, so the seconds part can never print as 60.0
  const tenths = Math.round(s * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/** Format a level in dB; anything at or below the floor reads "-inf dB". A negative zero prints as zero. */
export function formatDb(db: number, digits = 1): string {
  if (Number.isNaN(db) || db <= DB_FLOOR) {
    return "-inf dB";
  }
  const text = db.toFixed(digits);
  const unsigned =
    text.startsWith("-") && Number(text) === 0 ? text.slice(1) : text;
  return `${unsigned} dB`;
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
