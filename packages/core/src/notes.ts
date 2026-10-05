/* Note numbers, names and frequencies. MIDI numbering: 60 = C-4 = 261.63 Hz, 69 = A-4 = 440 Hz. */

export const NOTE_NAMES = [
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

const LETTER_SEMITONE: Record<string, number> = {
  a: 9,
  b: 11,
  c: 0,
  d: 2,
  e: 4,
  f: 5,
  g: 7,
};
const NOTE_RE = /^([A-Ga-g])([-#+b]?)(-?\d)$/;

/** Frequency of a (possibly fractional) MIDI note, with optional cents. */
export function noteToHz(note: number, cents = 0): number {
  return 440 * 2 ** ((note - 69 + cents / 100) / 12);
}

/** Fractional MIDI note of a frequency. Returns -Infinity for hz <= 0. */
export function hzToNote(hz: number): number {
  if (!(hz > 0)) {
    return Number.NEGATIVE_INFINITY;
  }
  return 69 + 12 * Math.log2(hz / 440);
}

/** 60 -> "C-4", 61 -> "C#4". Fractional notes round to the nearest. */
export function noteName(note: number): string {
  const n = Math.round(note);
  const pc = ((n % 12) + 12) % 12;
  const octave = Math.floor(n / 12) - 1;
  return `${NOTE_NAMES[pc] ?? "C-"}${octave}`;
}

/** "C#4" -> 61, "c+4" -> 61, "Db4" -> 61, "C-4" -> 60. Null when it is not a note or is outside 0..127. */
export function parseNoteName(s: string): number | null {
  const m = NOTE_RE.exec(s.trim());
  if (!m) {
    return null;
  }
  const base = LETTER_SEMITONE[(m[1] ?? "").toLowerCase()];
  if (base === undefined) {
    return null;
  }
  let acc = 0;
  if (m[2] === "#" || m[2] === "+") {
    acc = 1;
  } else if (m[2] === "b") {
    acc = -1;
  }
  const octave = Number(m[3]);
  const n = (octave + 1) * 12 + base + acc;
  return n >= 0 && n <= 127 ? n : null;
}
