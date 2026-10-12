/* Exporting an Amiga song as a 4 channel ProTracker module (.mod), and the Amiga part of the song's master section:
   stereo separation, the output filter model and the LED filter. The conversion is core's `songToMod` (the same code as
   `bleepkit export mod`); what does not fit a module is listed in a notice. */
import { app } from "../app.ts";
import { download } from "../export-local.ts";
import type { Song } from "../lib/contract.ts";
import { songToMod } from "../lib/core.ts";
import { h } from "../lib/dom.ts";
import { type Doc, project } from "../state/docs.ts";
import { rangeField, selectField, toggleField } from "./fields.ts";
import { icon } from "./icons.ts";
import { openModal } from "./modal.ts";

function showIssues(name: string, lines: string[]): void {
  openModal(
    h(
      "div",
      { class: "confirm" },
      h("p", {}, `What could not go into ${name}.mod exactly:`),
      h("ul", { class: "muted" }, ...lines.map((l) => h("li", {}, l)))
    ),
    { cls: "wide" }
  );
}

/** Convert the song and download it. A song that cannot be a module gets a notice saying why. */
export function exportMod(doc: Doc): void {
  const song = doc.value as Song;
  const result = songToMod(song, project.instruments(), project.samples());
  const error = result.issues.find((i) => i.severity === "error");
  if (!result.bytes || error) {
    app.toast(`Cannot export ${doc.id} as a module: ${error?.message ?? "unknown problem"}`);
    return;
  }
  download(`${doc.id}.mod`, result.bytes, "audio/x-mod");
  const lines = result.issues.map((i) => i.message);
  if (lines.length === 0) {
    app.toast(`Exported ${doc.id}.mod`);
  } else {
    app.toast(
      `Exported ${doc.id}.mod; ${lines.length} ${lines.length === 1 ? "thing" : "things"} did not fit a module`,
      "Details",
      () => showIssues(doc.id, lines)
    );
  }
}

/** The Amiga controls of the master section, and the export button. `edit` changes the song in place. */
export function amigaFields(
  body: HTMLElement,
  song: Song,
  doc: () => Doc,
  edit: (fn: (d: Song) => void, key: string) => void,
  rebuild: () => void
): void {
  const amiga = song.master.amiga;
  if (!amiga) {
    return;
  }
  rangeField(body, {
    label: "Stereo separation",
    max: 1,
    min: 0,
    onInput: (v) =>
      edit((d) => {
        if (d.master.amiga) {
          d.master.amiga.separation = v;
        }
      }, "amiga-sep"),
    step: 0.01,
    title: "1 is Paula's hard left and right, 0 is mono",
    value: amiga.separation,
  });
  selectField<string>(body, {
    label: "Output filter",
    onInput: (v) => {
      edit((d) => {
        if (d.master.amiga) {
          d.master.amiga.model = v === "a1200" ? "a1200" : "a500";
        }
      }, "amiga-model");
      rebuild();
    },
    options: [
      { label: "A500 (4.4 kHz lowpass)", value: "a500" },
      { label: "A1200 (no lowpass)", value: "a1200" },
    ],
    value: amiga.model,
  });
  toggleField(body, {
    label: "LED filter",
    onInput: (on) =>
      edit((d) => {
        if (d.master.amiga) {
          d.master.amiga.led = on;
        }
      }, "amiga-led"),
    value: amiga.led,
  });
  const button = h("button", {
    class: "btn small",
    title: "Download this song as a ProTracker module",
    type: "button",
  });
  button.innerHTML = `${icon("export", 12)}<span>Export as .mod</span>`;
  button.addEventListener("click", () => exportMod(doc()));
  body.append(h("div", { class: "fld" }, button));
}
