/* Deleting a sound effect, a song or an instrument (from its editor or the pads): ask first, remove the document and its file through the store,
   stop what the engine holds of it, and keep a toast with Undo that writes the same document back. */
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import type { Instrument, Sfx, Song, UserSample } from "../lib/contract.ts";
import { fire, h } from "../lib/dom.ts";
import { releaseNote, stopEverything } from "../playback.ts";
import { type Doc, project } from "../state/docs.ts";
import { icon } from "./icons.ts";
import { confirmDialog } from "./modal.ts";

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/** The songs that name instrument `id`, in a channel, a pattern row or MML text (`@id`). */
function songsUsing(id: string): Doc[] {
  const word = new RegExp(
    `(^|[^a-z0-9-])${id.replace(REGEX_SPECIALS, "\\$&")}($|[^a-z0-9-])`
  );
  return project.list("song").filter((d) => {
    const { channels, patterns } = d.value as Song;
    return word.test(JSON.stringify([channels, patterns]));
  });
}

/** The instruments that play user sample `id`. */
function instrumentsPlaying(id: string): Doc[] {
  return project
    .list("instrument")
    .filter((d) => (d.value as Instrument).sample?.userSample === id);
}

function question(doc: Doc, name: string): string {
  if (doc.kind === "sample") {
    const used = instrumentsPlaying(doc.id).length;
    const warn =
      used > 0
        ? ` ${used === 1 ? "One instrument plays" : `${used} instruments play`} it and will fall silent.`
        : "";
    return `Delete the sample "${name}"? Its file is removed from the project.${warn}`;
  }
  if (doc.kind === "instrument") {
    const used = songsUsing(doc.id).length;
    const warn =
      used > 0
        ? ` ${used === 1 ? "One song uses" : `${used} songs use`} it and will be left without it.`
        : "";
    return `Delete the instrument "${name}"? Its file is removed from the project.${warn}`;
  }
  if (doc.kind === "sfx") {
    return `Delete the sound effect "${name}"? Its file is removed from the project.`;
  }
  return `Delete the song "${name}"? Its file is removed from the project.`;
}

/** Ask, then delete `doc` (an sfx, a song or an instrument) and go back to the pads (unless `navigate` is false: the
 *  assistant deletes while the person is looking at something else). Resolves true when it was deleted. */
export async function deleteDocument(
  doc: Doc,
  opts: { navigate?: boolean; signal?: AbortSignal } = {}
): Promise<boolean> {
  const value = JSON.parse(JSON.stringify(doc.value)) as
    | Sfx
    | Song
    | Instrument
    | UserSample;
  const { kind, id } = doc;
  const name = value.name || id;
  if (
    !(await confirmDialog(question(doc, name), "Delete", {
      ...(opts.signal ? { signal: opts.signal } : {}),
    }))
  ) {
    return false;
  }
  if (kind === "song" && engine.hasSong(id)) {
    stopEverything();
  } else {
    releaseNote();
  }
  try {
    await project.remove(doc);
  } catch (err) {
    app.toast(`Could not delete ${name}: ${(err as Error).message}`);
    return false;
  }
  if (opts.navigate !== false) {
    app.navigate("#/pads");
  }
  app.toast(`Deleted ${name}`, "Undo", () => {
    fire(
      project.create(kind, id, value).then((back) => {
        if (back.kind !== "sfx") {
          app.navigate(`#/${back.kind}/${back.id}`);
        }
        app.toast(`Brought back ${name}`);
      })
    );
  });
  return true;
}

/** The Delete button an editor puts at the bottom of its inspector. */
export function deleteButton(doc: () => Doc, label: string): HTMLElement {
  const b = h("button", {
    class: "btn small danger",
    title: "Delete this document and its file",
    type: "button",
  });
  b.innerHTML = `${icon("trash", 12)}<span>${label}</span>`;
  b.addEventListener("click", () => fire(deleteDocument(doc())));
  return b;
}
