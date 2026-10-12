/* The one-click fix for the inspector's warning 'instrument "lead" was designed for chip "nes", this song uses
   "genesis"': every channel that plays that instrument swaps to one that fits its kind and role, an instrument of the
   project made for the chip (or for none) when there is one, else a new one from the per-chip presets. The new
   instruments and the song change together, so the song side is one undo step. */
import { app } from "../app.ts";
import { CHIP_THEME } from "../lib/chips.ts";
import type { Instrument, Issue, Song } from "../lib/contract.ts";
import { fixMisfits } from "../lib/core.ts";
import { h } from "../lib/dom.ts";
import { type Doc, project } from "../state/docs.ts";

const CHIP_WARNING =
  /^instrument "(.+)" was designed for chip "([a-z0-9]+)", this song uses "([a-z0-9]+)"$/;

/** The instrument and the song's chip a chip warning names, or null for any other issue. */
function chipWarning(
  issue: Pick<Issue, "message">
): { chip: string; id: string; made: string } | null {
  const m = CHIP_WARNING.exec(issue.message);
  return m ? { chip: m[3] ?? "", id: m[1] ?? "", made: m[2] ?? "" } : null;
}

const plural = (n: number, one: string): string =>
  `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * Swaps `id` for a fitting instrument on every channel of the song that plays it. Resolves true when the song changed.
 * The instruments it needs are made first (the song names them), then the song is edited in one step.
 */
async function useFittingInstrument(
  doc: Doc<Song>,
  id: string
): Promise<boolean> {
  const result = fixMisfits(doc.value, project.instruments(), new Set([id]));
  if (result.swaps.length === 0) {
    app.toast("Nothing to change: no channel plays that instrument any more");
    return false;
  }
  try {
    for (const made of result.created) {
      // biome-ignore lint/performance/noAwaitInLoops: each instrument is stored in turn, the song is edited after the last
      await project.create(
        "instrument",
        made,
        result.instruments[made] as Instrument
      );
    }
  } catch (err) {
    app.toast(`Could not make the instrument: ${(err as Error).message}`);
    return false;
  }
  project.edit<Song>(doc, () => result.song);
  const chip = CHIP_THEME[doc.value.chip].short;
  const channels = [...new Set(result.swaps.map((s) => s.channel))];
  const to = [...new Set(result.swaps.map((s) => s.to))];
  const made =
    result.created.length > 0
      ? ` (${plural(result.created.length, "new instrument")} made from the ${chip} presets)`
      : "";
  app.toast(
    `${channels.join(", ")} now ${channels.length === 1 ? "plays" : "play"} ${to.join(", ")}${made}`,
    "Undo",
    () => app.undo()
  );
  return true;
}

/** The "Use a <chip> instrument" button for a chip warning, or null for any other issue. */
export function fixInstrumentButton(
  doc: () => Doc<Song>,
  issue: Issue
): HTMLElement | null {
  const w = chipWarning(issue);
  if (!w) {
    return null;
  }
  const label = `Use a ${CHIP_THEME[doc().value.chip].short} instrument`;
  return h(
    "button",
    {
      class: "btn small issue-fix",
      onclick: () => {
        useFittingInstrument(doc(), w.id).catch((err: unknown) =>
          app.toast(String((err as Error).message))
        );
      },
      title: `Replace "${w.id}" with an instrument made for ${CHIP_THEME[doc().value.chip].short} (the project's own if there is one, else a new one), on every channel that plays it`,
    },
    label
  );
}
