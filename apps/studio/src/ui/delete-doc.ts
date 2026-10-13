/* Duplicating and deleting a sound effect, a song, an instrument or a sample (from its editor, the pads or the sidebar's
   context menu). Delete asks first, removes the document and its file through the store, stops what the engine holds of
   it, and keeps a toast with Undo that writes the same document back. Duplicate writes a copy under a free id and name
   and goes to it. */
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

/** Copy `doc` (see `project.duplicate`), say what the copy is called and open it (unless `navigate` is false: the pads
 *  stay where they are). Resolves to the copy, or null when it could not be written. */
export async function duplicateDocument(
  doc: Doc,
  opts: { navigate?: boolean } = {}
): Promise<Doc | null> {
  let copy: Doc;
  try {
    copy = await project.duplicate(doc);
  } catch (err) {
    app.toast(`Could not duplicate: ${(err as Error).message}`);
    return null;
  }
  if (opts.navigate !== false) {
    app.navigate(`#/${copy.kind}/${encodeURIComponent(copy.id)}`);
  }
  const name = (copy.value as { name?: string }).name || copy.id;
  app.toast(`Duplicated as ${name}`);
  return copy;
}

/** The Duplicate button an editor puts at the bottom of its inspector. */
function duplicateButton(doc: () => Doc, label = "Duplicate"): HTMLElement {
  const b = h("button", {
    class: "btn small",
    title: "Make a copy of this document and open it",
    type: "button",
  });
  b.innerHTML = `${icon("copy", 12)}<span>${label}</span>`;
  b.addEventListener("click", () => fire(duplicateDocument(doc())));
  return b;
}

/** The Delete button an editor puts at the bottom of its inspector. */
function deleteButton(doc: () => Doc, label: string): HTMLElement {
  const b = h("button", {
    class: "btn small danger",
    title: "Delete this document and its file",
    type: "button",
  });
  b.innerHTML = `${icon("trash", 12)}<span>${label}</span>`;
  b.addEventListener("click", () => fire(deleteDocument(doc())));
  return b;
}

/** The row at the bottom of every editor's inspector: Duplicate and Delete side by side. */
export function docActions(doc: () => Doc, deleteLabel: string): HTMLElement {
  return h(
    "div",
    { class: "insp-danger" },
    duplicateButton(doc),
    deleteButton(doc, deleteLabel)
  );
}
