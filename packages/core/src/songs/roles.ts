/* Roles: what a line of notes does in a piece of music. The MIDI importer (which parts go to which chip channel) and
   rechipSong (which channels of a song go to which channel of another chip) tell lead, harmony, bass and drums apart the
   same way, so the measures live here: how busy a line is, how high it sits, and which busy line is the bass. */

export type Role = "lead" | "harmony" | "bass" | "drums";

/** What the role decisions need to know about a line: how many notes start in it, and its median pitch. */
export interface LineStats {
  median: number;
  /** Distinct start times: chords count once, so this measures how much the line has to say. */
  onsets: number;
}

const SCORE_SPAN = 36;
const BASS_MIN_ONSETS = 4;
const BASS_MIN_SHARE = 0.15;
const BASS_GAP = 5;

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Busyness weighted a little towards high lines: the lead is the best score. */
export function partScore(onsets: number, medianPitch: number): number {
  const lift = Math.max(-0.5, Math.min(0.5, (medianPitch - 60) / SCORE_SPAN));
  return onsets * (1 + lift);
}

/**
 * The lowest busy candidate (at least 4 onsets and 15 percent of the busiest line's), when some other line of the piece
 * (`all`) has a median at least 5 semitones higher; null otherwise. A piece with one melodic line has no bass.
 */
export function pickBass<T extends LineStats>(
  candidates: readonly T[],
  all: readonly LineStats[]
): T | null {
  const most = Math.max(0, ...all.map((p) => p.onsets));
  const busy = candidates.filter(
    (p) => p.onsets >= Math.max(BASS_MIN_ONSETS, most * BASS_MIN_SHARE)
  );
  const [lowest] = [...busy].sort(
    (a, b) => a.median - b.median || b.onsets - a.onsets
  );
  if (!lowest) {
    return null;
  }
  const above = all.some(
    (p) => p !== lowest && p.median >= lowest.median + BASS_GAP
  );
  return above ? lowest : null;
}
