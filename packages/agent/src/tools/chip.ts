// Moving a song to another chip: the same rechipSong the studio's Chip control uses, so the song keeps its music
// (lead, bass, drums and harmony move to the channels of the new chip that suit them) and the tool reports what moved
// where and what did not fit.
import {
  CHIP_IDS,
  type ChipId,
  describeRechip,
  type Instrument,
  rechipSong,
  type Song,
} from "@bleepkit/core";
import { type AgentHost, refText } from "../host.ts";
import { type AgentTool, defineTool, done, fail } from "../tool-kit.ts";
import { commit } from "./commit.ts";
import { refOf } from "./documents.ts";

const MAX_LINES = 12;

function lines(title: string, items: readonly string[]): string {
  if (items.length === 0) {
    return "";
  }
  const shown = items.slice(0, MAX_LINES).map((l) => `- ${l}`);
  const more = items.length - MAX_LINES;
  return `${title}\n${shown.join("\n")}${more > 0 ? `\n- ... and ${more} more` : ""}\n`;
}

export function changeSongChip(host: AgentHost): AgentTool {
  return defineTool<{ chip: ChipId; ref: string }>({
    description:
      "Move a song to another chip without losing its music. Each channel gets a role from what it plays (drums, bass, lead, harmony) and moves to the channel of the new chip that suits it, with its notes fitted to the channel's range, effects the chip cannot do removed, and an instrument of the right kind (a project instrument when one fits, else a new preset). When the new chip has fewer channels the least important line is written into the rests of another or dropped, and the reply says which. Use this instead of editing /chip with edit_document.",
    inputSchema: {
      properties: {
        chip: { enum: CHIP_IDS, type: "string" },
        ref: { description: 'The song, like "song/title".', type: "string" },
      },
      required: ["ref", "chip"],
      type: "object",
    },
    name: "change_song_chip",
    run: async (input) => {
      const parsed = refOf(input.ref);
      if (parsed.error) {
        return parsed.error;
      }
      const name = refText(parsed.ref);
      if (parsed.ref.kind !== "song") {
        return fail(
          "Not a song",
          `${name} is not a song: only songs have a chip to change here. For a sound effect or an instrument use edit_document on /chip.`
        );
      }
      const song = (await host.read(parsed.ref)) as Song | null;
      if (!song) {
        return fail(`No ${name}`, `There is no ${name}.`);
      }
      if (song.chip === input.chip) {
        return done(
          `${name} is already ${input.chip}`,
          `${name} already uses ${input.chip}, nothing was changed.`
        );
      }
      const result = rechipSong(song, await host.instruments(), input.chip);
      for (const id of result.created) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, an instrument is written before the song names it
        const made = await commit(
          host,
          { id, kind: "instrument" },
          result.instruments[id] as Instrument,
          { create: true }
        );
        if (made.out.isError) {
          return made.out;
        }
      }
      const saved = await commit(host, parsed.ref, result.song, {
        verb: "Changed the chip of",
      });
      if (saved.out.isError) {
        return saved.out;
      }
      const words = describeRechip(result);
      const text = [
        `Moved ${name} from ${song.chip} to ${input.chip}.`,
        lines("Moved:", words.moved),
        lines("Dropped:", words.dropped),
        lines("Changed to fit:", words.adjusted),
        lines(
          "New instruments:",
          result.created.map((id) => `instrument/${id}`)
        ),
        "Tell the person what moved where and what was dropped; they can undo it.",
      ]
        .filter(Boolean)
        .join("\n");
      return done(
        `Moved ${name} to ${input.chip}: ${result.moves.length} channels moved, ${result.dropped.length} dropped`,
        text
      );
    },
  });
}
