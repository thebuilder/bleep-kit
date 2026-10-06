/* From the notes of the parts on one chip channel to that channel's rows: quantize to the row grid, keep one note at a
   time (the top note, or the bass note), fold the notes into the channel's range, and count what was lost. */

import type { Effect } from "../types.ts";
import type { MidiNote } from "./parse.ts";
import type { Part } from "./parts.ts";
import { type DrumVoice, drumVoice, type Range } from "./plan.ts";

/** A note on the row grid. */
export interface GridNote {
  /** Last row it sounds on, exclusive; at least one row after `row`. */
  end: number;
  note: number;
  /** Start row (absolute, from the start of the song). */
  row: number;
  /** Start tick, for messages. */
  tick: number;
  velocity: number;
  /** The drum it is, for percussion parts. */
  voice?: DrumVoice;
}

/** One thing that happens on a row of a channel. */
export interface ChannelEvent {
  /** The drum hit, so the sample chip can pick an instrument per drum. */
  drum?: DrumVoice;
  /** Effects written on the row (the arpeggio of a chord, or the `000` that ends it). */
  fx?: Effect[];
  /** A MIDI note number, or "off". */
  note: number | "off";
  row: number;
  velocity: number;
}

export interface Loss {
  /** Notes that could not sound because another note owns the channel at that moment. */
  dropped: number;
  /** Tick of the first dropped note. */
  firstDropped: number | null;
  /** Notes that were folded into the range one by one (the contour changes). */
  folded: number;
  /** Whole octaves the part was moved to fit the range. */
  shiftOctaves: number;
  /** Notes cut short by the next note starting before they ended. */
  shortened: number;
}

/** How chords are handled: `top` keeps one note, `spread` puts the extra notes on free channels, `arpeggio` turns them
 *  into a `0xy` effect, `auto` spreads first and arpeggiates what is left. */
export const CHORD_MODES = ["auto", "spread", "arpeggio", "top"] as const;
export type ChordMode = (typeof CHORD_MODES)[number];

/** A note of a chord that the channel's own line does not keep. */
export interface ChordNote {
  end: number;
  /** MIDI note, moved by the part's octave shift but not yet folded into any channel's range. */
  note: number;
  tick: number;
  velocity: number;
}

/** Notes that start on one row of a melodic channel: the line keeps `primary`, `extras` wait to be placed. */
export interface Chord {
  /** Row where the longest note of the chord ends. */
  end: number;
  /** The other notes, the one furthest from the primary first. */
  extras: ChordNote[];
  /** The note the line plays (already in the channel's range): the top note, or the lowest on the bass. */
  primary: number;
  row: number;
}

export interface Reduced {
  /** Chords still to place (always empty in `top` mode, and for drums). */
  chords: Chord[];
  events: ChannelEvent[];
  loss: Loss;
}

export function emptyLoss(): Loss {
  return {
    dropped: 0,
    firstDropped: null,
    folded: 0,
    shiftOctaves: 0,
    shortened: 0,
  };
}

export interface Grid {
  ppq: number;
  rowsPerBeat: number;
}

export function tickToRow(grid: Grid, tick: number): number {
  return Math.round((tick * grid.rowsPerBeat) / grid.ppq);
}

/** How far a tick is from the row it was rounded to, in rows (0 to 0.5). */
export function gridError(grid: Grid, tick: number): number {
  const exact = (tick * grid.rowsPerBeat) / grid.ppq;
  return Math.abs(exact - Math.round(exact));
}

export function toGrid(grid: Grid, part: Part, note: MidiNote): GridNote {
  const row = tickToRow(grid, note.start);
  const out: GridNote = {
    end: Math.max(row + 1, tickToRow(grid, note.end)),
    note: note.note,
    row,
    tick: note.start,
    velocity: note.velocity,
  };
  if (part.drums) {
    out.voice = drumVoice(note.note);
  }
  return out;
}

/** Notes starting on the same row, in row order. */
function groupByRow(notes: GridNote[]): GridNote[][] {
  const sorted = [...notes].sort((a, b) => a.row - b.row || a.tick - b.tick);
  const groups: GridNote[][] = [];
  for (const n of sorted) {
    const last = groups.at(-1);
    if (last && last[0]?.row === n.row) {
      last.push(n);
    } else {
      groups.push([n]);
    }
  }
  return groups;
}

function noteDropped(loss: Loss, note: GridNote): void {
  loss.dropped += 1;
  loss.firstDropped = Math.min(loss.firstDropped ?? note.tick, note.tick);
}

/** The note that stays of a group: the highest (or lowest for a bass) one; the others are lost. */
function choose(
  group: GridNote[],
  better: (a: GridNote, b: GridNote) => boolean,
  loss: Loss
): GridNote {
  let best = group[0] as GridNote;
  for (const n of group.slice(1)) {
    if (better(n, best)) {
      noteDropped(loss, best);
      best = n;
    } else {
      noteDropped(loss, n);
    }
  }
  return best;
}

const SHIFTS = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6] as const;
/** Up to this share of notes outside the range is fixed note by note; more moves the whole part. */
const STRAY_SHARE = 0.2;

function outside(notes: GridNote[], range: Range, shift: number): number {
  const [low, high] = range;
  return notes.filter((n) => {
    const v = n.note + shift * 12;
    return v < low || v > high;
  }).length;
}

/** The octave shift for a whole part: none when only a few notes stray, else the one that leaves the fewest outside. */
function chooseShift(notes: GridNote[], range: Range): number {
  if (outside(notes, range, 0) <= notes.length * STRAY_SHARE) {
    return 0;
  }
  let best = 0;
  let bestOut = Number.POSITIVE_INFINITY;
  for (const k of SHIFTS) {
    const out = outside(notes, range, k);
    if (out < bestOut) {
      bestOut = out;
      best = k;
    }
  }
  return best;
}

/** A note moved by whole octaves into a range. */
export function foldInto(note: number, range: Range): number {
  const [low, high] = range;
  let v = note;
  while (v < low) {
    v += 12;
  }
  while (v > high) {
    v -= 12;
  }
  return v;
}

/** One octave shift for the whole part (the contour stays), then single notes folded in what still sticks out. */
function fitRange(notes: GridNote[], range: Range, loss: Loss): GridNote[] {
  const shift = chooseShift(notes, range);
  loss.shiftOctaves = shift;
  return notes.map((n) => {
    const start = n.note + shift * 12;
    const v = foldInto(start, range);
    if (v !== start) {
      loss.folded += 1;
    }
    return { ...n, note: v };
  });
}

/** Rows of a monophonic line: a note on at its row, an off when it ends before the next one starts. */
function lineEvents(picks: GridNote[], loss: Loss): ChannelEvent[] {
  const events: ChannelEvent[] = [];
  for (const [i, n] of picks.entries()) {
    events.push({ note: n.note, row: n.row, velocity: n.velocity });
    const next = picks[i + 1];
    if (next && n.end > next.row) {
      loss.shortened += 1;
    } else if (!next || n.end < next.row) {
      events.push({ note: "off", row: n.end, velocity: 0 });
    }
  }
  return events;
}

/** The note of a group the line keeps, and the rest ordered by distance from it (furthest first, then lower first). */
function splitGroup(
  group: GridNote[],
  better: (a: GridNote, b: GridNote) => boolean
): { extras: GridNote[]; primary: GridNote } {
  let primary = group[0] as GridNote;
  for (const n of group.slice(1)) {
    if (better(n, primary)) {
      primary = n;
    }
  }
  const extras = group
    .filter((n) => n !== primary)
    .sort(
      (a, b) =>
        Math.abs(b.note - primary.note) - Math.abs(a.note - primary.note) ||
        a.note - b.note
    );
  return { extras, primary };
}

/** The chord of a group once the part's octave shift is known; notes that repeat a pitch are dropped here. */
function chordOf(
  primary: GridNote,
  extras: GridNote[],
  group: GridNote[],
  fitted: GridNote,
  shift: number,
  loss: Loss
): Chord | null {
  const seen = new Set([primary.note + shift * 12]);
  const kept: ChordNote[] = [];
  for (const n of extras) {
    const note = n.note + shift * 12;
    if (seen.has(note)) {
      noteDropped(loss, n);
    } else {
      seen.add(note);
      kept.push({ end: n.end, note, tick: n.tick, velocity: n.velocity });
    }
  }
  if (kept.length === 0) {
    return null;
  }
  return {
    end: Math.max(...group.map((n) => n.end)),
    extras: kept,
    primary: fitted.note,
    row: primary.row,
  };
}

/**
 * A melodic channel plays one note at a time. Notes that start on the same row are a chord: the top one stays (the
 * lowest for the bass channel). In `top` mode the others are dropped; otherwise they come back as `chords` for the
 * placement step (spread to free channels, or an arpeggio). A note that starts while an earlier one is still held
 * takes over from it.
 */
export function reduceMelodic(
  notes: GridNote[],
  opts: { bass: boolean; chords?: ChordMode; range: Range }
): Reduced {
  const loss = emptyLoss();
  const better = opts.bass
    ? (a: GridNote, b: GridNote) => a.note < b.note
    : (a: GridNote, b: GridNote) => a.note > b.note;
  const groups = groupByRow(notes);
  if ((opts.chords ?? "top") === "top") {
    const picks = groups.map((g) => choose(g, better, loss));
    const fitted = fitRange(picks, opts.range, loss);
    return { chords: [], events: lineEvents(fitted, loss), loss };
  }
  const split = groups.map((g) => splitGroup(g, better));
  const fitted = fitRange(
    split.map((s) => s.primary),
    opts.range,
    loss
  );
  const chords: Chord[] = [];
  for (const [i, s] of split.entries()) {
    const chord = chordOf(
      s.primary,
      s.extras,
      groups[i] as GridNote[],
      fitted[i] as GridNote,
      loss.shiftOctaves,
      loss
    );
    if (chord) {
      chords.push(chord);
    }
  }
  return { chords, events: lineEvents(fitted, loss), loss };
}

/** The pitched notes of a drum channel: one hit per row. The most important drum wins (kick, snare, toms, hats and
 *  cymbals), and between equal drums the louder hit. */
export function reduceDrums(notes: GridNote[]): Reduced {
  const loss = emptyLoss();
  const better = (a: GridNote, b: GridNote) => {
    const pa = a.voice?.priority ?? 0;
    const pb = b.voice?.priority ?? 0;
    return pa > pb || (pa === pb && a.velocity > b.velocity);
  };
  const picks = groupByRow(notes).map((g) => choose(g, better, loss));
  const events: ChannelEvent[] = picks.map((n) => {
    const e: ChannelEvent = {
      note: n.voice?.pitch ?? n.note,
      row: n.row,
      velocity: n.velocity,
    };
    if (n.voice) {
      e.drum = n.voice;
    }
    return e;
  });
  return { chords: [], events, loss };
}
