/* Chords on chips that play one note per channel, the way 80s and 90s composers did it: first spread the extra notes
   over channels that are free at that moment, then turn what is left into a `0xy` arpeggio on the part's own channel.
   Works on the channels' events after the one-note reduction, so it only ever adds notes to a channel at moments when
   nothing else plays there. */

import type { ChannelKind } from "../types.ts";
import type { Range } from "./plan.ts";
import {
  type ChannelEvent,
  type Chord,
  type ChordMode,
  type ChordNote,
  foldInto,
  type Loss,
} from "./reduce.ts";

/** A chip channel as the placement sees it: the events it plays now, and the chords its own part still has to place. */
export interface ChordHost {
  chords: Chord[];
  events: ChannelEvent[];
  id: string;
  kind: ChannelKind;
  loss: Loss;
  /** May take spread notes: a harmony channel (not the lead, not the bass, not drums the file really has). */
  open: boolean;
  /** Position in the chip's plan: the tie-break between equal choices. */
  order: number;
  range: Range;
}

/** What happened to the chords of one channel, for the report. */
export interface ChordStats {
  /** Chords that became an arpeggio on this channel. */
  arps: number;
  /** Intervals of those arpeggios that were folded down an octave to fit 0 to 15. */
  folded: number;
  /** Chords with at least one note spread to another channel. */
  spread: number;
  /** Chords spread to each channel (channel id to count). */
  targets: Map<string, number>;
}

function newStats(): ChordStats {
  return { arps: 0, folded: 0, spread: 0, targets: new Map() };
}

const MAX_OFFSET = 15;
const OCTAVE = 12;

/* ---------- finding free channels ---------- */

/** Index of the first event on a row greater than `row`. */
function after(events: ChannelEvent[], row: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((events[mid] as ChannelEvent).row <= row) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The row where the channel next has an event, when nothing sounds on it at `row` (null when it is busy, infinity when
 * it stays free to the end). A note off on `row` itself counts as free: the new note takes its place.
 */
function freeUntil(events: ChannelEvent[], row: number): number | null {
  const i = after(events, row);
  const last = events[i - 1];
  if (last && last.note !== "off") {
    return null;
  }
  return events[i]?.row ?? Number.POSITIVE_INFINITY;
}

/** Puts a note and its end on a channel that is free at `row` until `until`. */
function insertNote(
  host: ChordHost,
  note: number,
  velocity: number,
  row: number,
  end: number
): void {
  const { events } = host;
  const at = after(events, row - 1);
  if (events[at]?.row === row) {
    // a note off on this row: the new note replaces it
    events.splice(at, 1);
  }
  events.splice(at, 0, { note, row, velocity });
  const next = events[at + 1];
  if (!next || next.row > end) {
    events.splice(at + 1, 0, { note: "off", row: end, velocity: 0 });
  }
}

interface Target {
  host: ChordHost;
  until: number;
}

/** Free channels for a chord, best first: free for the whole chord, then of the same kind, then in the plan's order. */
function targetsFor(
  hosts: ChordHost[],
  source: ChordHost,
  chord: Chord,
  wanted: number
): Target[] {
  const free: Target[] = [];
  for (const host of hosts) {
    if (host.open && host !== source) {
      const until = freeUntil(host.events, chord.row);
      if (until !== null) {
        free.push({ host, until });
      }
    }
  }
  const rank = (t: Target) =>
    (t.until >= chord.end ? 0 : 2) + (t.host.kind === source.kind ? 0 : 1);
  free.sort((a, b) => rank(a) - rank(b) || a.host.order - b.host.order);
  return free.slice(0, wanted);
}

/* ---------- arpeggio ---------- */

/** How much an interval says about a chord: the third and the seventh first, then the fifth, then colour tones. */
const CHARACTER: readonly number[] = [
  1, // octave
  2, // minor second
  3, // second
  9, // minor third
  9, // major third
  4, // fourth
  5, // tritone, diminished fifth
  7, // fifth
  5, // augmented fifth
  3, // sixth
  8, // minor seventh
  8, // major seventh
];

export interface Arpeggio {
  base: number;
  /** Notes of the chord the arpeggio does not play. */
  dropped: number;
  /** Intervals that were above 15 semitones and were folded down by octaves. */
  folded: number;
  x: number;
  y: number;
}

/**
 * The arpeggio for a set of notes: the lowest plays, the `0xy` steps are the two most characteristic other tones
 * (each 1 to 15 semitones above it, folded down by octaves to fit). With one other tone, `x` and `y` are both it. Null
 * when all the notes are the same pitch.
 */
export function arpeggioOf(notes: number[]): Arpeggio | null {
  const base = Math.min(...notes);
  // one candidate per pitch class, the lowest one
  const byClass = new Map<number, number>();
  for (const n of [...notes].sort((a, b) => a - b)) {
    const offset = n - base;
    if (offset > 0 && !byClass.has(offset % OCTAVE)) {
      byClass.set(offset % OCTAVE, offset);
    }
  }
  // the octave doubling of the root counts too, as an offset of 12
  const candidates = [...byClass.entries()].sort(
    ([a], [b]) => (CHARACTER[b] ?? 0) - (CHARACTER[a] ?? 0) || a - b
  );
  const chosen = candidates.slice(0, 2).map(([, offset]) => offset);
  if (chosen.length === 0) {
    return null;
  }
  let folded = 0;
  const steps = chosen
    .map((offset) => {
      let o = offset;
      while (o > MAX_OFFSET) {
        o -= OCTAVE;
      }
      folded += o === offset ? 0 : 1;
      return o;
    })
    .sort((a, b) => a - b);
  const x = steps[0] as number;
  return {
    base,
    dropped: notes.length - 1 - chosen.length,
    folded,
    x,
    y: steps[1] ?? x,
  };
}

/* ---------- placing ---------- */

function noteDropped(loss: Loss, tick: number): void {
  loss.dropped += 1;
  loss.firstDropped = Math.min(loss.firstDropped ?? tick, tick);
}

function chordTick(chord: Chord): number {
  return Math.min(...chord.extras.map((n) => n.tick));
}

/** Spreads as many extra notes as there are free channels; returns the ones that found none. */
function spreadChord(
  hosts: ChordHost[],
  source: ChordHost,
  chord: Chord,
  stats: Map<string, ChordStats>
): ChordNote[] {
  const targets = targetsFor(hosts, source, chord, chord.extras.length);
  for (const [i, target] of targets.entries()) {
    const n = chord.extras[i] as ChordNote;
    const note = foldInto(n.note, target.host.range);
    if (note !== n.note) {
      target.host.loss.folded += 1;
    }
    const end = Math.min(n.end, target.until);
    if (end < n.end) {
      target.host.loss.shortened += 1;
    }
    insertNote(target.host, note, n.velocity, chord.row, end);
    const mine = stats.get(source.id) as ChordStats;
    mine.targets.set(
      target.host.id,
      (mine.targets.get(target.host.id) ?? 0) + 1
    );
  }
  if (targets.length > 0) {
    (stats.get(source.id) as ChordStats).spread += 1;
  }
  return chord.extras.slice(targets.length);
}

/** Turns the chord's own notes (the line's note and the leftovers) into an arpeggio on the event at the chord's row. */
function arpeggiate(
  source: ChordHost,
  chord: Chord,
  rest: ChordNote[],
  stats: ChordStats
): void {
  const own = [
    chord.primary,
    ...rest.map((n) => foldInto(n.note, source.range)),
  ];
  const arp = arpeggioOf(own);
  const at = after(source.events, chord.row - 1);
  const event = source.events[at];
  if (!(arp && event) || event.row !== chord.row) {
    // every leftover note repeats the line's pitch: nothing to play
    for (const n of rest) {
      noteDropped(source.loss, n.tick);
    }
    return;
  }
  event.note = arp.base;
  event.fx = [{ type: "arp", x: arp.x, y: arp.y }];
  stats.arps += 1;
  stats.folded += arp.folded;
  for (let i = 0; i < arp.dropped; i += 1) {
    noteDropped(source.loss, chordTick(chord));
  }
}

/** Ends every arpeggio: the next note without one of its own gets `000` (a note off already stops it). */
function endArpeggios(events: ChannelEvent[]): void {
  let on = false;
  for (const e of events) {
    if (e.note === "off") {
      on = false;
    } else if (e.fx?.some((f) => f.type === "arp" && (f.x > 0 || f.y > 0))) {
      on = true;
    } else if (on) {
      e.fx = [...(e.fx ?? []), { type: "arp", x: 0, y: 0 }];
      on = false;
    }
  }
}

/**
 * Places every chord: in time order, so two parts that want the same free channel are served first come first served
 * (the plan's order on a tie). `spread` and `auto` put the extra notes on free channels, `arpeggio` and `auto` turn
 * what is left into an arpeggio; notes that are neither are dropped and counted on the channel's loss.
 */
export function placeChords(
  hosts: ChordHost[],
  mode: Exclude<ChordMode, "top">
): Map<string, ChordStats> {
  const stats = new Map(hosts.map((h) => [h.id, newStats()]));
  const queue = hosts.flatMap((host) =>
    host.chords.map((chord) => ({ chord, host }))
  );
  queue.sort(
    (a, b) => a.chord.row - b.chord.row || a.host.order - b.host.order
  );
  for (const { chord, host } of queue) {
    const rest =
      mode === "arpeggio"
        ? chord.extras
        : spreadChord(hosts, host, chord, stats);
    if (rest.length === 0) {
      continue;
    }
    if (mode === "spread") {
      for (const n of rest) {
        noteDropped(host.loss, n.tick);
      }
    } else {
      arpeggiate(host, chord, rest, stats.get(host.id) as ChordStats);
    }
  }
  for (const host of hosts) {
    endArpeggios(host.events);
  }
  return stats;
}
