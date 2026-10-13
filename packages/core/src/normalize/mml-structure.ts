/* The structure an MML-only song gets: empty patterns of four beats that give the song its length for the studio's
   tracker view. Patterns are named for what they hold, not for their position: the section names the author wrote in
   MML comments (`; section: Chorus`), else A, B, C... by content. Two bars that hold the same music, in every channel,
   are one pattern that the order list plays twice. See architecture.md section 2.7. */

import { type GridTiming, mmlToRows } from "../mml/grid.ts";
import type { MmlSection } from "../mml/parser.ts";
import type { Pattern } from "../types.ts";
import { PPQ } from "../types.ts";
import { formatRowString } from "./effects.ts";

export const SYNTH_PATTERN_BEATS = 4;
const MAX_PATTERNS = 256;
const MAX_NAME = 40;
const LETTERS = 26;

/** One MML channel as the structure needs it: its text and the sections its comments name. */
export interface MmlSource {
  mml: string;
  sections: readonly MmlSection[];
}

export interface Structure {
  order: string[];
  patterns: Record<string, Pattern>;
}

/** The rows of every MML channel cut into bars: the key of each bar is what the bar holds, relative to its start. */
function barKeys(
  sources: readonly MmlSource[],
  timing: GridTiming,
  count: number
): string[] {
  const perBar = SYNTH_PATTERN_BEATS * timing.rowsPerBeat;
  const bars: string[][] = Array.from({ length: count }, () => []);
  for (const [ci, source] of sources.entries()) {
    const { rows } = mmlToRows(source.mml, timing);
    for (const row of rows) {
      const bar = Math.floor(row.row / perBar);
      if (bar < count) {
        bars[bar]?.push(
          `${ci}:${row.row - bar * perBar}:${formatRowString(row)}`
        );
      }
    }
  }
  return bars.map((b) => b.join("|"));
}

/** The sections of all channels by pulse (the first channel to name a pulse wins). */
function mergeSections(sources: readonly MmlSource[]): MmlSection[] {
  const seen = new Set<number>();
  const out: MmlSection[] = [];
  for (const source of sources) {
    for (const s of source.sections) {
      if (!seen.has(s.pulse)) {
        seen.add(s.pulse);
        out.push(s);
      }
    }
  }
  return out.sort((a, b) => a.pulse - b.pulse);
}

/** A section name as a pattern id: one line, no runs of blanks, at most MAX_NAME characters. */
function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
}

/** A, B, ... Z, AA, AB ... for the nth unnamed pattern (from 0). */
function letterName(n: number): string {
  let rest = n;
  let out = "";
  do {
    out = String.fromCharCode(65 + (rest % LETTERS)) + out;
    rest = Math.floor(rest / LETTERS) - 1;
  } while (rest >= 0);
  return out;
}

/**
 * The name of bar `k` from the sections: the bar a section starts in is named for it ("Verse"), the bars after it
 * "Verse b", "Verse c"; the second time a name is used it is "Verse 2", "Verse 2b". Null before the first section.
 */
function sectionOf(
  sections: readonly MmlSection[],
  k: number,
  barPulses: number
): string | null {
  const from = k * barPulses;
  const seen = new Map<string, number>();
  let current: { first: number; name: string; occurrence: number } | null =
    null;
  for (const s of sections) {
    if (s.pulse >= from + barPulses - 1e-6) {
      break;
    }
    const name = cleanName(s.name);
    const occurrence = (seen.get(name.toLowerCase()) ?? 0) + 1;
    seen.set(name.toLowerCase(), occurrence);
    const first = Math.max(0, Math.floor(s.pulse / barPulses + 1e-6));
    current = { first, name, occurrence };
    if (first === k) {
      break;
    }
  }
  if (current === null || current.name === "") {
    return null;
  }
  const stem =
    current.occurrence === 1
      ? current.name
      : `${current.name} ${current.occurrence}`;
  const into = k - current.first;
  if (into === 0) {
    return stem;
  }
  const letter = letterName(into).toLowerCase();
  return current.occurrence === 1 ? `${stem} ${letter}` : `${stem}${letter}`;
}

/**
 * The patterns and order of an MML-only song: one order entry per four beats of the longest channel (so an entry's
 * position is its place in time), the patterns shared between entries whose bars hold the same notes.
 */
export function synthesizeStructure(
  sources: readonly MmlSource[],
  mmlEnd: number,
  timing: GridTiming
): Structure {
  const { rowsPerBeat } = timing;
  const patterns: Record<string, Pattern> = {};
  const order: string[] = [];
  const barPulses = SYNTH_PATTERN_BEATS * PPQ;
  const perPattern = SYNTH_PATTERN_BEATS * rowsPerBeat;
  const total = Math.max(mmlEnd, 1);
  const count = Math.min(
    MAX_PATTERNS,
    Math.max(1, Math.ceil(total / barPulses - 1e-9))
  );
  const keys = barKeys(sources, timing, count);
  const sections = mergeSections(sources);
  const byKey = new Map<string, string>();
  let letters = 0;
  const free = (base: string): string => {
    let id = base;
    for (let n = 2; id in patterns; n += 1) {
      id = `${base} ${n}`;
    }
    return id;
  };
  for (let k = 0; k < count; k += 1) {
    const key = keys[k] ?? "";
    let id = byKey.get(key);
    if (id === undefined) {
      const named = sectionOf(sections, k, barPulses);
      if (named === null) {
        let letter = letterName(letters);
        letters += 1;
        while (letter in patterns) {
          letter = letterName(letters);
          letters += 1;
        }
        id = letter;
      } else {
        id = free(named);
      }
      byKey.set(key, id);
      patterns[id] = { generated: true, length: perPattern, tracks: {} };
    }
    order.push(id);
  }
  return { order, patterns };
}
