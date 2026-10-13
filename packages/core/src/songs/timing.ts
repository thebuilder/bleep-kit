/* The timing of a song as the tracker plays it: what turns an MML position into a row and a delay (Gxx) or a cut
   (Sxx) and back. Pure. See architecture.md section 2.7. */

import type { GridTiming } from "../mml/grid.ts";
import { effectByte } from "../normalize/effects.ts";
import type { Song } from "../types.ts";
import { PPQ } from "../types.ts";

/** The song row where an order entry starts: the lengths of the patterns before it. */
export function orderStartRow(
  song: Pick<Song, "order" | "patterns">,
  orderIdx: number
): number {
  let row = 0;
  for (let i = 0; i < orderIdx && i < song.order.length; i += 1) {
    row += song.patterns[song.order[i] ?? ""]?.length ?? 0;
  }
  return row;
}

/** The tempo changes the patterns make (Fxx), as [pulse, BPM] in the time order of the order list. */
function tempoChanges(song: Song): [number, number][] {
  const ppr = PPQ / song.rowsPerBeat;
  const found = new Map<number, number>();
  let start = 0;
  for (const id of song.order) {
    const pat = song.patterns[id];
    for (const rows of Object.values(pat?.tracks ?? {})) {
      for (const r of rows) {
        for (const e of r.fx) {
          if (e.type === "tempo") {
            found.set((start + r.row) * ppr, effectByte(e));
          }
        }
      }
    }
    start += pat?.length ?? 0;
  }
  return [...found.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * What the engine does with time in this song: the rows per beat, the tempo and its changes (Fxx rows), the tick rate,
 * and where the tick grid is anchored again (the start of the loop section). `loopStart` overrides the loop of the
 * song itself (an MML loop point that is not on an order boundary yet).
 */
export function songTiming(song: Song, loopStart?: number | null): GridTiming {
  const ppr = PPQ / song.rowsPerBeat;
  let start = loopStart ?? null;
  if (loopStart === undefined && song.loop !== null) {
    start = orderStartRow(song, song.loop) * ppr;
  }
  return {
    changes: tempoChanges(song),
    rowsPerBeat: song.rowsPerBeat,
    tempo: song.tempo,
    tickRate: song.tickRate,
    ...(start === null ? {} : { loopStart: start }),
  };
}
