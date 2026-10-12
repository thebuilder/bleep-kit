/* What a song's channels do: how many notes each plays, how high, with which instruments, and whether it is a drum
   line. rechipSong reads this to give every channel a role before it decides where it goes. */

import { parseMml } from "../mml/index.ts";
import type { Instrument, Song, SongChannel } from "../types.ts";
import { isDrumInstrument } from "./instrument-roles.ts";
import { median } from "./roles.ts";

/** One note a channel plays, as written. */
export interface NoteFact {
  /** The instrument in effect for the note (a row's, the running one, or the channel's), or null. */
  inst: string | null;
  note: number;
  /** How many times the note sounds in one play of the song (the times its pattern is in the order). */
  plays: number;
}

export interface ChannelFacts {
  channel: SongChannel;
  /** Drums: a noise channel, or a channel whose notes play drum instruments. */
  drums: boolean;
  median: number;
  notes: NoteFact[];
  /** Notes that start in one play of the song: how busy the channel is. */
  onsets: number;
  /** Notes as the file has them: a pattern that plays three times counts once. */
  written: number;
}

/** How often each pattern is played. */
function patternPlays(song: Song): Map<string, number> {
  const plays = new Map<string, number>();
  for (const id of song.order) {
    plays.set(id, (plays.get(id) ?? 0) + 1);
  }
  return plays;
}

/** A pattern that is never played still has notes: it weighs a little, so a channel that only has those still has a role. */
const UNPLAYED_WEIGHT = 0.01;

function trackerNotes(
  song: Song,
  channel: SongChannel,
  plays: Map<string, number>
): NoteFact[] {
  const out: NoteFact[] = [];
  for (const [id, pattern] of Object.entries(song.patterns)) {
    let inst = channel.instrument;
    for (const row of pattern.tracks[channel.id] ?? []) {
      inst = row.inst ?? inst;
      if (typeof row.note === "number") {
        out.push({
          inst,
          note: row.note,
          plays: plays.get(id) ?? UNPLAYED_WEIGHT,
        });
      }
    }
  }
  return out;
}

function mmlNotes(channel: SongChannel, text: string): NoteFact[] {
  const out: NoteFact[] = [];
  for (const e of parseMml(text).events) {
    if (e.type === "note") {
      out.push({ inst: e.inst ?? channel.instrument, note: e.note, plays: 1 });
    }
  }
  return out;
}

function playsDrums(
  channel: SongChannel,
  notes: readonly NoteFact[],
  instruments: Record<string, Instrument>
): boolean {
  if (channel.kind === "noise") {
    return true;
  }
  const drumNotes = notes.filter(
    (n) => n.inst !== null && isDrumInstrument(n.inst, instruments[n.inst])
  ).length;
  return notes.length > 0 && drumNotes * 2 >= notes.length;
}

export function gatherFacts(
  song: Song,
  instruments: Record<string, Instrument>
): ChannelFacts[] {
  const plays = patternPlays(song);
  return song.channels.map((channel) => {
    const notes = channel.mml
      ? mmlNotes(channel, channel.mml)
      : trackerNotes(song, channel, plays);
    return {
      channel,
      drums: playsDrums(channel, notes, instruments),
      median: median(notes.map((n) => n.note)),
      notes,
      onsets: notes.reduce((sum, n) => sum + n.plays, 0),
      written: notes.length,
    };
  });
}
