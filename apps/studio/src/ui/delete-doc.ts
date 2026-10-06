/* Deleting a song or an instrument from its editor: ask first, remove the document and its file through the store,
   stop what the engine holds of it, and keep a toast with Undo that writes the same document back. */
import { app } from "../app.ts";
import { engine } from "../engine/engine.ts";
import type { Instrument, Song } from "../lib/contract.ts";
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

function question(doc: Doc, name: string): string {
  if (doc.kind === "instrument") {
    const used = songsUsing(doc.id).length;
    const warn =
      used > 0
        ? ` ${used === 1 ? "One song uses" : `${used} songs use`} it and will be left without it.`
        : "";
    return `Delete the instrument "${name}"? Its file is removed from the project.${warn}`;
  }
  return `Delete the song "${name}"? Its file is removed from the project.`;
}

/** Ask, then delete `doc` (a song or an instrument) and go back to the pads. Resolves true when it was deleted. */
export async function deleteDocument(doc: Doc): Promise<boolean> {
  const value = JSON.parse(JSON.stringify(doc.value)) as Song | Instrument;
  const { kind, id } = doc;
  const name = value.name || id;
  if (!(await confirmDialog(question(doc, name), "Delete"))) {
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
  app.navigate("#/pads");
  app.toast(`Deleted ${name}`, "Undo", () => {
    fire(
      project.create(kind, id, value).then((back) => {
        app.navigate(`#/${back.kind}/${back.id}`);
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
