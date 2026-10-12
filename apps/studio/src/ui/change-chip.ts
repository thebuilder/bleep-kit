/* Changing a song's chip: work out where each channel goes on the new chip (rechipSong), ask first with what moves where
   and what will be dropped, create the instruments the move needs, and apply the whole change as one edit, so it is one
   undo step. A toast says what happened and offers Undo. */
import { app } from "../app.ts";
import { CHIP_THEME } from "../lib/chips.ts";
import type { ChipId, Song } from "../lib/contract.ts";
import { describeRechip, rechipSong } from "../lib/core.ts";
import { type Doc, project } from "../state/docs.ts";
import { confirmDialog } from "./modal.ts";

const MAX_LINES = 12;

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? "" : "s"}`;

/** At most `MAX_LINES` lines, the rest counted. */
function capped(lines: string[]): string[] {
  return lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES), `... and ${lines.length - MAX_LINES} more`]
    : lines;
}

/**
 * Moves the song to `chip`. Resolves true when the chip was changed, false when the person said no (or the song
 * already has that chip). A song with nothing in it to move changes at once, without a question.
 */
export async function changeSongChip(
  doc: Doc<Song>,
  chip: ChipId
): Promise<boolean> {
  const song = doc.value;
  if (song.chip === chip) {
    return false;
  }
  const result = rechipSong(song, project.instruments(), chip);
  const words = describeRechip(result);
  const from = CHIP_THEME[song.chip].short;
  const to = CHIP_THEME[chip].short;
  if (words.moved.length > 0 || words.dropped.length > 0) {
    const yes = await confirmDialog(
      `Change "${song.name}" from ${from} to ${to}? Each channel moves to the one of ${to} that suits it.`,
      "Change chip",
      {
        cls: "wide",
        lists: [
          { lines: capped(words.moved), title: "Moves:" },
          { lines: capped(words.dropped), title: "Will be dropped:" },
          { lines: capped(words.adjusted), title: "Changed to fit:" },
          {
            lines: capped(result.created.map((id) => `instrument ${id}`)),
            title: "New instruments:",
          },
        ],
      }
    );
    if (!yes) {
      return false;
    }
  }
  // the song names the new instruments, so they exist before the song changes
  try {
    for (const id of result.created) {
      // biome-ignore lint/performance/noAwaitInLoops: each instrument is written in turn, the song is edited after the last
      await project.create("instrument", id, result.instruments[id] as never);
    }
  } catch (err) {
    app.toast(`Could not change the chip: ${(err as Error).message}`);
    return false;
  }
  project.edit<Song>(doc, () => result.song);
  const lost = result.dropped.reduce((n, d) => n + d.notes, 0);
  const parts = [
    `${plural(result.moves.length, "channel")} moved`,
    ...(lost > 0 ? [`${plural(lost, "note")} dropped`] : []),
    ...(result.created.length > 0
      ? [`${plural(result.created.length, "instrument")} added`]
      : []),
  ];
  app.toast(`Changed to ${to}: ${parts.join(", ")}`, "Undo", () => app.undo());
  return true;
}
