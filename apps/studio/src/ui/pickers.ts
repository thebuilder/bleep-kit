/* The "New ..." pickers: 13 sfx categories with an icon and a hint each, instrument kinds, and creating documents. */
import { app } from "../app.ts";
import {
  CATEGORY_KIND,
  categoryColor,
  KIND_HEX,
  KIND_LABEL,
} from "../lib/chips.ts";
import type { ChannelKind, SfxCategory } from "../lib/contract.ts";
import { SFX_CATEGORIES } from "../lib/contract.ts";
import {
  chipProfile,
  defaultInstrument,
  defaultSong,
  deriveSeed,
  generateSfx,
} from "../lib/core.ts";
import { h } from "../lib/dom.ts";
import { playSfx } from "../playback.ts";
import { type Doc, project } from "../state/docs.ts";
import { icon } from "./icons.ts";
import { openModal } from "./modal.ts";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Generate a sound of a category, save it as a new document and play it at once. */
export async function createSfx(
  category: SfxCategory,
  opts: { navigate?: boolean } = {}
): Promise<Doc> {
  const base = category;
  const id = project.uniqueId("sfx", base);
  const seed =
    deriveSeed(project.project.seed, `${id}:${project.list("sfx").length}`) %
    1_000_000;
  const sfx = generateSfx(category, {
    chip: project.project.chip,
    name: `${cap(category)} ${seed % 1000}`,
    seed,
  });
  const doc = await project.create("sfx", id, sfx);
  playSfx(doc);
  if (opts.navigate) {
    app.navigate(`#/sfx/${doc.id}`);
  }
  return doc;
}

export function pickCategory(onPick: (c: SfxCategory) => void): void {
  const grid = h("div", { class: "cat-grid" });
  let close: () => void = () => undefined;
  for (const c of SFX_CATEGORIES) {
    const color = categoryColor(c);
    grid.append(
      h(
        "button",
        {
          class: "cat-tile",
          onclick: () => {
            close();
            onPick(c);
          },
          style: `--kc:${color}`,
        },
        h("span", { class: "ci" }, ""),
        h("b", {}, cap(c)),
        h("small", {}, CATEGORY_KIND[c].hint)
      )
    );
    (grid.lastElementChild?.querySelector(".ci") as HTMLElement).innerHTML =
      icon(c, 32);
  }
  const wrap = h(
    "div",
    { class: "pick" },
    h(
      "div",
      { class: "pick-h" },
      h("span", { class: "pxh" }, "New sound effect"),
      h(
        "small",
        { class: "muted" },
        "Pick a flavor. It is generated and plays at once."
      )
    ),
    grid
  );
  close = openModal(wrap, { cls: "wide" });
}

export function pickKind(onPick: (k: ChannelKind) => void): void {
  const chip = chipProfile(project.project.chip);
  const grid = h("div", { class: "cat-grid kinds" });
  let close: () => void = () => undefined;
  const kinds: ChannelKind[] = [
    "pulse",
    "triangle",
    "noise",
    "wave",
    "sid",
    "fm",
    "sample",
  ];
  const hints: Record<ChannelKind, string> = {
    fm: "Operators and algorithms",
    noise: "Drums and rumble",
    pulse: "Square wave with a duty cycle",
    sample: "Generated 16 bit samples",
    sid: "Waveforms, PWM and a filter",
    triangle: "Soft bass, no volume steps",
    wave: "32 step wavetable",
  };
  for (const k of kinds) {
    const fits = chip.kinds.includes(k);
    const tile = h(
      "button",
      {
        class: `cat-tile ${fits ? "" : "dim"}`,
        onclick: () => {
          close();
          onPick(k);
        },
        style: `--kc:${KIND_HEX[k]}`,
      },
      h("span", { class: "ci" }, ""),
      h("b", {}, KIND_LABEL[k]),
      h("small", {}, fits ? hints[k] : `${hints[k]} (not on ${chip.label})`)
    );
    (tile.querySelector(".ci") as HTMLElement).innerHTML = icon(k, 32);
    grid.append(tile);
  }
  close = openModal(
    h(
      "div",
      { class: "pick" },
      h(
        "div",
        { class: "pick-h" },
        h("span", { class: "pxh" }, "New instrument"),
        h("small", { class: "muted" }, "Pick a sound source.")
      ),
      grid
    ),
    { cls: "wide" }
  );
}

export async function createInstrument(kind: ChannelKind): Promise<void> {
  const id = project.uniqueId(
    "instrument",
    kind === "pulse" ? "pulse-lead" : `${kind}-voice`
  );
  const { chip } = project.project;
  const inst = defaultInstrument(
    kind,
    chipProfile(chip).kinds.includes(kind) ? chip : null
  );
  inst.name = `${cap(kind)} voice`;
  const doc = await project.create("instrument", id, inst);
  app.navigate(`#/instrument/${doc.id}`);
}

export async function createSong(): Promise<void> {
  const id = project.uniqueId("song", "new-song");
  const song = defaultSong(project.project.chip);
  song.name = "New song";
  const insts = project.list("instrument");
  for (const ch of song.channels) {
    const match = insts.find(
      (i) => (i.value as { kind: string }).kind === ch.kind
    );
    if (match) {
      ch.instrument = match.id;
    }
  }
  const doc = await project.create("song", id, song);
  app.navigate(`#/song/${doc.id}`);
}
