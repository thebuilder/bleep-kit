/* Importing a ProTracker module (.mod): the small dialog that asks for the stereo separation, then the conversion by
   core's `modToSong` (the same code as `bleepkit import song.mod`). The module's samples become sample documents, the
   used ones get a sample instrument each, and the song is created and opened. What did not map is listed in a notice. */
import { app } from "../app.ts";
import type { Issue } from "../lib/contract.ts";
import { type ModImport, modToSong } from "../lib/core.ts";
import { fire, h } from "../lib/dom.ts";
import { project } from "../state/docs.ts";
import { openModal } from "./modal.ts";

const MOD_NAME = /\.mod$/i;

const SEPARATION: [string, number][] = [
  ["Full (Paula's hard left and right)", 1],
  ["Softened (50%)", 0.5],
  ["Mono", 0],
];

const songName = (file: string): string =>
  file.replace(MOD_NAME, "").trim() || "MOD song";

const messages = (issues: Issue[], severity: "info" | "other"): string[] =>
  issues
    .filter((i) => (i.severity === "info") === (severity === "info"))
    .map((i) => i.message);

function list(title: string, lines: string[]): HTMLElement[] {
  if (lines.length === 0) {
    return [];
  }
  const ul = h("ul", { class: "muted" });
  for (const line of lines) {
    ul.append(h("li", {}, line));
  }
  return [h("p", {}, title), ul];
}

function showIssues(name: string, converted: string[], lost: string[]): void {
  openModal(
    h(
      "div",
      { class: "confirm" },
      ...list(`What was converted in ${name}:`, converted),
      ...list(`What did not map from ${name}:`, lost)
    ),
    { cls: "wide" }
  );
}

/** A song id whose sample and instrument ids (`<id>-01-name`) are all free in the project. */
function freeSongId(name: string, bytes: Uint8Array): string {
  for (let n = 0; n < 50; n += 1) {
    const id = project.uniqueId("song", n === 0 ? name : `${name}-${n + 1}`);
    const r = modToSong(bytes, { id, name });
    const taken =
      Object.keys(r.samples).some((s) => project.get("sample", s)) ||
      Object.keys(r.instruments).some((i) => project.get("instrument", i));
    if (!taken) {
      return id;
    }
  }
  return project.uniqueId("song", name);
}

async function create(
  result: ModImport,
  id: string
): Promise<void> {
  for (const [sid, sample] of Object.entries(result.samples)) {
    // biome-ignore lint/performance/noAwaitInLoops: samples before instruments before the song, each normalized against the last
    await project.create("sample", sid, sample);
  }
  for (const [iid, inst] of Object.entries(result.instruments)) {
    // biome-ignore lint/performance/noAwaitInLoops: see above
    await project.create("instrument", iid, inst);
  }
  const doc = await project.create("song", id, result.song);
  app.navigate(`#/song/${encodeURIComponent(doc.id)}`);
}

async function importMod(
  bytes: Uint8Array,
  file: string,
  opts: { loop: boolean; separation: number }
): Promise<void> {
  const name = songName(file);
  const id = freeSongId(name, bytes);
  const result = modToSong(bytes, { id, name, ...opts });
  const error = result.issues.find((i) => i.severity === "error");
  if (error) {
    app.toast(`Could not import ${file}: ${error.message}`);
    return;
  }
  await create(result, id);
  const converted = messages(result.issues, "info");
  const lost = messages(result.issues, "other");
  const count = Object.keys(result.samples).length;
  const head = `Imported ${name} with ${count} ${count === 1 ? "sample" : "samples"}`;
  if (lost.length === 0) {
    app.toast(head, converted.length > 0 ? "Details" : undefined, () =>
      showIssues(name, converted, lost)
    );
    return;
  }
  app.toast(
    `${head}; ${lost.length} ${lost.length === 1 ? "thing" : "things"} did not map`,
    "Details",
    () => showIssues(name, converted, lost)
  );
}

/** Asks for the options, then imports. A file that is not a module gets a notice instead of a dialog. */
export function openModBytes(bytes: Uint8Array, file: string): void {
  const check = modToSong(bytes, { id: "check" }).issues.find(
    (i) => i.severity === "error"
  );
  if (check) {
    app.toast(`Could not import ${file}: ${check.message}`);
    return;
  }
  const sep = h("select", { "aria-label": "Stereo separation" });
  for (const [label, value] of SEPARATION) {
    sep.append(h("option", { value: String(value) }, label));
  }
  const loop = h("input", { id: "mod-loop", type: "checkbox" });
  (loop as HTMLInputElement).checked = true;
  let close: () => void = () => undefined;
  const go = h(
    "button",
    {
      class: "btn primary",
      onclick: () => {
        close();
        fire(
          importMod(bytes, file, {
            loop: (loop as HTMLInputElement).checked,
            separation: Number(sep.value),
          })
        );
      },
    },
    "Import"
  );
  close = openModal(
    h(
      "div",
      { class: "confirm" },
      h(
        "p",
        {},
        `Import ${file} as a song with its samples and one instrument per sample.`
      ),
      h("p", {}, "Stereo separation:"),
      sep,
      h(
        "label",
        { class: "tgl-row", for: "mod-loop" },
        loop,
        h("small", {}, " Loop the song")
      ),
      h(
        "div",
        { class: "confirm-btns" },
        h("button", { class: "btn", onclick: () => close() }, "Cancel"),
        go
      )
    ),
    { cls: "narrow" }
  );
  sep.focus();
}

export async function openModFile(file: File): Promise<void> {
  openModBytes(new Uint8Array(await file.arrayBuffer()), file.name);
}

export const isModName = (name: string): boolean => MOD_NAME.test(name);
