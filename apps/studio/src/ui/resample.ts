/* "Resample": turn what an sfx or an instrument note sounds like into a user sample, the way a sampler of the 80s and
   90s kept a sound. The render is core's `captureSample` (the same code as `bleepkit resample` and the assistant's
   resample tool): mixed to mono, trimmed, and converted for the project's chip. 8 bit and a low rate are the crush. */
import { app } from "../app.ts";
import type {
  ChipId,
  Instrument,
  RenderResult,
  Sfx,
  Song,
} from "../lib/contract.ts";
import { captureSample, noteName, renderInstrumentNote } from "../lib/core.ts";
import { fire, h } from "../lib/dom.ts";
import { renderSfxAsync, renderSongAsync } from "../render-service.ts";
import { type Doc, project } from "../state/docs.ts";
import { openModal } from "./modal.ts";

export interface ResampleOpts {
  /** Store at 8 bit (the crush). */
  bits?: 8 | 16;
  /** For an instrument: how long the note is held, in seconds. */
  duration?: number;
  /** The sample's document id. Default: made from the sound's name. */
  id?: string;
  name?: string;
  /** For an instrument: the note to play. */
  note?: number;
  /** Open the sample editor afterwards. Default true. */
  open?: boolean;
  /** Sample rate to store at. */
  rate?: number;
}

export interface Resampled {
  id: string;
  notes: string[];
}

/** The chip a sample is converted for: the project's, unless it is the free-form custom chip. */
const chipFor = (chip: ChipId): ChipId | null =>
  chip === "custom" ? null : chip;

/** Render a document the way the studio plays it. */
function renderForResample(
  doc: Doc,
  opts: ResampleOpts
): Promise<RenderResult> {
  if (doc.kind === "sfx") {
    return renderSfxAsync(doc.value as Sfx);
  }
  if (doc.kind === "song") {
    return renderSongAsync(doc.value as Song, project.instruments());
  }
  const inst = doc.value as Instrument;
  const master = { ...project.project.master };
  return Promise.resolve(
    renderInstrumentNote(inst, opts.note ?? 60, {
      duration: opts.duration ?? 0.6,
      master,
      samples: project.samplesFor({ inst }),
    })
  );
}

/** Make a sample document from a document's render. Throws when the sample is not valid. */
export async function resampleDoc(
  doc: Doc,
  opts: ResampleOpts = {}
): Promise<Resampled> {
  const render = await renderForResample(doc, opts);
  const name =
    opts.name ??
    `${(doc.value as { name?: string }).name || doc.id} sample`.slice(0, 60);
  const baseNote = doc.kind === "instrument" ? (opts.note ?? 60) : undefined;
  const { notes, sample } = captureSample(render, {
    chip: chipFor(project.project.chip),
    name,
    ...(baseNote === undefined ? {} : { baseNote }),
    ...(opts.bits === undefined ? {} : { bits: opts.bits }),
    ...(opts.rate === undefined ? {} : { rate: opts.rate }),
  });
  const created = await project.create(
    "sample",
    opts.id ?? project.uniqueId("sample", name),
    sample
  );
  const bad = created.issues.find((i) => i.severity === "error");
  if (bad) {
    throw new Error(bad.message);
  }
  if (opts.open !== false) {
    app.navigate(`#/sample/${encodeURIComponent(created.id)}`);
  }
  return { id: created.id, notes };
}

const RATES = [
  { label: "The chip's own rate", value: "0" },
  { label: "22050 Hz", value: "22050" },
  { label: "11025 Hz", value: "11025" },
  { label: "8000 Hz (grit)", value: "8000" },
];

/** The dialog behind the Resample buttons. `test` is the instrument's test note and its length. */
export function openResample(
  doc: Doc,
  test: { duration?: number; note?: number } = {}
): void {
  const { note } = test;
  const what =
    doc.kind === "instrument"
      ? `${noteName(note ?? 60)} played on ${doc.id}`
      : `${doc.id}`;
  const crush = h("input", { id: "rsCrush", type: "checkbox" });
  const rate = h(
    "select",
    { id: "rsRate" },
    ...RATES.map((r) => h("option", { value: r.value }, r.label))
  ) as HTMLSelectElement;
  const { chip } = project.project;
  const hint =
    chip === "amiga" || chip === "genesis"
      ? "This chip stores samples at 8 bit already."
      : "16 bit keeps the sound as it is. 8 bit crushes it.";
  let close: () => void = () => undefined;
  const go = h(
    "button",
    {
      class: "btn primary",
      id: "rsGo",
      onclick: () => {
        const bits = (crush as HTMLInputElement).checked ? 8 : undefined;
        const hz = Number(rate.value);
        close();
        fire(
          resampleDoc(doc, {
            ...(bits ? { bits } : {}),
            ...(hz > 0 ? { rate: hz } : {}),
            ...(note === undefined ? {} : { note }),
            ...(test.duration === undefined ? {} : { duration: test.duration }),
          }).then(
            (r) => app.toast(`Made sample ${r.id}: ${r.notes.join(", ")}`),
            (err: Error) => app.toast(`Could not resample: ${err.message}`)
          )
        );
      },
    },
    "Make sample"
  );
  close = openModal(
    h(
      "div",
      { class: "confirm" },
      h("p", {}, `Record ${what} as a user sample.`),
      h(
        "label",
        { class: "tgl-row" },
        h("span", { class: "tgl" }, crush, h("span", {})),
        h("small", {}, "Crush to 8 bit")
      ),
      h("label", { class: "fsel" }, h("span", {}, "Sample rate"), rate),
      h("p", { class: "muted" }, hint),
      h(
        "div",
        { class: "confirm-btns" },
        h("button", { class: "btn", onclick: () => close() }, "Cancel"),
        go
      )
    ),
    { cls: "narrow" }
  );
  go.focus();
}
