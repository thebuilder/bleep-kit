/* What a view shows when the project has nothing in it yet: a plain sentence and the obvious next steps as buttons
   (New SFX, New song, Import MIDI, Open examples), so a clean project never looks broken. */
import { app } from "../app.ts";
import { fire, h } from "../lib/dom.ts";
import { icon } from "./icons.ts";
import { pickMidiFile } from "./import-midi.ts";
import { createSfx, createSong, pickCategory } from "./pickers.ts";

interface Step {
  icon: string;
  id: string;
  label: string;
  primary?: boolean;
  run: () => void;
}

const steps = (): Step[] => [
  {
    icon: "plus",
    id: "sfx",
    label: "New SFX",
    primary: true,
    run: () =>
      pickCategory((c) =>
        fire(createSfx(c, { navigate: app.route.view !== "pads" }))
      ),
  },
  {
    icon: "song",
    id: "song",
    label: "New song",
    run: () => fire(createSong()),
  },
  {
    icon: "import",
    id: "midi",
    label: "Import MIDI",
    run: pickMidiFile,
  },
  {
    icon: "headphones",
    id: "examples",
    label: "Open examples",
    run: () => app.navigate("#/examples"),
  },
];

/** The four next steps as a row of buttons. */
export function nextSteps(): HTMLElement {
  const row = h("div", { class: "btn-row empty-steps" });
  for (const s of steps()) {
    const b = h("button", {
      class: `btn${s.primary ? " primary" : ""}`,
      "data-step": s.id,
      type: "button",
    });
    b.innerHTML = `${icon(s.icon, 14)}<span>${s.label}</span>`;
    b.addEventListener("click", s.run);
    row.append(b);
  }
  return row;
}

/** A panel for an empty view: heading, a line of explanation, then the next steps. */
export function emptyCard(title: string, text: string): HTMLElement {
  return h(
    "section",
    { class: "card empty-card" },
    h(
      "div",
      { class: "card-b" },
      h("h2", { class: "pxh" }, title),
      h("p", { class: "muted" }, text),
      nextSteps()
    )
  );
}
