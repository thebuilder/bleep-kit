/* Import MIDI: the file picker behind the sidebar button and the palette command, the drop target for .mid files, and
   the small dialog that asks which chip the song is for. The conversion itself is core's `midiToSong`; this file
   creates the instruments and the song through the project store and opens the song. */
import { app } from "../app.ts";
import type { ChipId } from "../lib/contract.ts";
import { CHIP_IDS } from "../lib/contract.ts";
import {
  CHORD_MODES,
  type ChordMode,
  chipProfile,
  midiToSong,
} from "../lib/core.ts";
import { fire, h } from "../lib/dom.ts";
import { project } from "../state/docs.ts";
import { openModal } from "./modal.ts";

const MIDI_NAME = /\.midi?$/i;

interface Source {
  bytes: Uint8Array;
  name: string;
}

const chips = CHIP_IDS.filter((c) => c !== "custom");

/** The file name without its extension: the song's name and, slugged, its id. */
const songName = (file: string): string =>
  file.replace(MIDI_NAME, "").trim() || "MIDI song";

const CHORD_LABELS: Record<ChordMode, string> = {
  arpeggio: "Arpeggio only (0xy on the part's channel)",
  auto: "Spread to free channels, then arpeggio",
  spread: "Spread to free channels only",
  top: "Top note only (the rest is dropped)",
};

/** The project's chip when a song can be imported for it, else the NES. */
function defaultChip(): ChipId {
  const { chip } = project.project;
  return chip === "custom" ? "nes" : chip;
}

function section(title: string, lines: string[]): HTMLElement[] {
  if (lines.length === 0) {
    return [];
  }
  const list = h("ul", { class: "muted" });
  for (const line of lines) {
    list.append(h("li", {}, line));
  }
  return [h("p", {}, title), list];
}

/** What became of the file: what was converted (chords spread or arpeggiated), then what the chip could not keep. */
function showIssues(name: string, converted: string[], lost: string[]): void {
  openModal(
    h(
      "div",
      { class: "confirm" },
      ...section(`What was converted in ${name}:`, converted),
      ...section(`What the chip could not keep of ${name}:`, lost)
    ),
    { cls: "wide" }
  );
}

const things = (n: number, what: string): string =>
  `${n} ${n === 1 ? "thing was" : "things were"} ${what}`;

/** The notice after an import: the conversions first (named when there is one), then the count of what was dropped. */
function noticeOf(name: string, converted: string[], lost: string[]): string {
  const parts: string[] = [];
  if (converted.length === 1) {
    parts.push(converted[0] as string);
  } else if (converted.length > 1) {
    parts.push(things(converted.length, "converted"));
  }
  if (lost.length > 0) {
    parts.push(things(lost.length, "dropped or changed"));
  }
  return `Imported ${name}: ${parts.join("; ")}`;
}

/** Converts, creates the instruments the project lacks, creates the song and opens it. False when it cannot be imported. */
async function importMidi(
  src: Source,
  chip: ChipId,
  chords: ChordMode = "auto"
): Promise<boolean> {
  const name = songName(src.name);
  const result = midiToSong(src.bytes, { chip, chords, name });
  const error = result.issues.find((i) => i.severity === "error");
  if (error) {
    app.toast(`Could not import ${src.name}: ${error.message}`);
    return false;
  }
  // the song names these instruments: the project's own copy wins when the same id exists already
  await Promise.all(
    Object.entries(result.instruments)
      .filter(([id]) => !project.get("instrument", id))
      .map(([id, inst]) => project.create("instrument", id, inst))
  );
  const doc = await project.create(
    "song",
    project.uniqueId("song", name),
    result.song
  );
  app.navigate(`#/song/${doc.id}`);
  const converted = result.issues
    .filter((i) => i.severity === "info")
    .map((i) => i.message);
  const lost = result.issues
    .filter((i) => i.severity !== "info")
    .map((i) => i.message);
  if (converted.length === 0 && lost.length === 0) {
    app.toast(`Imported ${name}`);
  } else {
    app.toast(noticeOf(name, converted, lost), "Details", () =>
      showIssues(name, converted, lost)
    );
  }
  return true;
}

/** Asks for the chip, then imports. A file that is not a MIDI file gets a notice instead of a dialog. */
function openImportDialog(src: Source): void {
  const check = midiToSong(src.bytes, { chip: defaultChip() }).issues.find(
    (i) => i.severity === "error"
  );
  if (check) {
    app.toast(`Could not import ${src.name}: ${check.message}`);
    return;
  }
  const select = h("select", { "aria-label": "Chip" });
  for (const chip of chips) {
    select.append(h("option", { value: chip }, chipProfile(chip).label));
  }
  select.value = defaultChip();
  const chordSelect = h("select", { "aria-label": "Chords" });
  for (const mode of CHORD_MODES) {
    chordSelect.append(h("option", { value: mode }, CHORD_LABELS[mode]));
  }
  chordSelect.value = "auto";
  let close: () => void = () => undefined;
  const go = h(
    "button",
    {
      class: "btn primary",
      onclick: () => {
        close();
        fire(
          importMidi(
            src,
            select.value as ChipId,
            chordSelect.value as ChordMode
          )
        );
      },
    },
    "Import"
  );
  for (const el of [select, chordSelect]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        go.click();
      }
    });
  }
  close = openModal(
    h(
      "div",
      { class: "confirm" },
      h("p", {}, `Import ${src.name} as a song for this chip:`),
      select,
      h("p", {}, "Chords (a channel plays one note at a time):"),
      chordSelect,
      h(
        "div",
        { class: "confirm-btns" },
        h("button", { class: "btn", onclick: () => close() }, "Cancel"),
        go
      )
    ),
    { cls: "narrow" }
  );
  select.focus();
}

async function openFile(file: File): Promise<void> {
  openImportDialog({
    bytes: new Uint8Array(await file.arrayBuffer()),
    name: file.name,
  });
}

/** Opens the system file picker for a .mid file. */
export function pickMidiFile(): void {
  const input = h("input", { accept: ".mid,.midi", type: "file" });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) {
      fire(openFile(file));
    }
  });
  input.click();
}

let dropInstalled = false;

/** True when the drag carries files from outside the page. An order chip or any other in-page drag does not, and must
 *  never be taken for a file drop. */
const carriesFiles = (e: DragEvent): boolean =>
  Array.from(e.dataTransfer?.types ?? []).includes("Files");

/** A .mid file dropped anywhere on the window opens the import dialog. Other dropped files are ignored, not opened. */
export function installMidiDrop(): void {
  if (dropInstalled) {
    return;
  }
  dropInstalled = true;
  window.addEventListener("dragover", (e) => {
    if (carriesFiles(e)) {
      e.preventDefault();
    }
  });
  window.addEventListener("drop", (e) => {
    if (!carriesFiles(e)) {
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) {
      return;
    }
    // without this the browser would navigate away from the studio to the dropped file
    e.preventDefault();
    const midi = files.find((f) => MIDI_NAME.test(f.name));
    if (midi) {
      fire(openFile(midi));
    }
  });
}
