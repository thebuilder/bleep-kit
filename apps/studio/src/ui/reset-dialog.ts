/* The dialog behind "New project" and "Start over": the same look as the delete confirmation (message, buttons at the
   bottom), plus the choices the action needs. It only collects answers; project-actions.ts does the work. */
import { CHIP_THEME } from "../lib/chips.ts";
import { CHIP_IDS, type ChipId } from "../lib/contract.ts";
import { h } from "../lib/dom.ts";
import { openModal } from "./modal.ts";

export type StartKind = "empty" | "starter";

export interface ResetOptions {
  chip: ChipId;
  /** Ask which kind of project to begin with (New project); left out when the kind is fixed (Start over). */
  choose?: boolean;
  /** The project has changes that no zip holds yet: offer to download it first. */
  hasChanges: boolean;
  kind: StartKind;
  message: string;
  name: string;
  okLabel: string;
}

export interface ResetAnswer {
  /** Download the current project as a zip before it is replaced. */
  backup: boolean;
  chip: ChipId;
  kind: StartKind;
  name: string;
}

const CHOICES: { kind: StartKind; title: string; text: string }[] = [
  {
    kind: "empty",
    text: "No sounds, songs or instruments. Just a project name and a chip.",
    title: "Empty project",
  },
  {
    kind: "starter",
    text: "A dozen sound effects, instruments of every kind and a short song to learn from.",
    title: "With the starter kit",
  },
];

function choiceRow(
  c: (typeof CHOICES)[number],
  checked: boolean,
  onPick: () => void
): HTMLElement {
  const input = h("input", {
    class: "choice-in",
    name: "start-kind",
    type: "radio",
    value: c.kind,
  }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", onPick);
  return h(
    "label",
    { class: "choice" },
    input,
    h("span", {}, h("b", {}, c.title), h("small", {}, c.text))
  );
}

/** Resolves with the answers, or null when the person cancels (Cancel, Escape or a click outside). */
export function resetDialog(o: ResetOptions): Promise<ResetAnswer | null> {
  return new Promise((resolve) => {
    let answered = false;
    let { kind } = o;
    let close: () => void = () => undefined;
    const name = h("input", {
      "aria-label": "Project name",
      maxlength: "60",
      spellcheck: "false",
      type: "text",
      value: o.name,
    }) as HTMLInputElement;
    const chip = h("select", { "aria-label": "Chip" }) as HTMLSelectElement;
    for (const id of CHIP_IDS) {
      chip.append(h("option", { value: id }, CHIP_THEME[id].short));
    }
    chip.value = o.chip;
    const fields = h(
      "div",
      { class: "choice-fields" },
      h("label", { class: "sel" }, h("span", {}, "Name"), name),
      h("label", { class: "sel" }, h("span", {}, "Chip"), chip)
    );
    const backupBox = h("input", {
      "aria-label": "Download the current project first",
      class: "choice-in",
      type: "checkbox",
    }) as HTMLInputElement;
    backupBox.checked = o.hasChanges;
    const backup = h(
      "label",
      { class: "choice-check" },
      backupBox,
      h("span", {}, "Download the current project as a zip first")
    );
    backup.hidden = !o.hasChanges;
    const syncFields = () => {
      fields.hidden = kind !== "empty" || !o.choose;
    };
    const answer = (yes: boolean) => {
      if (answered) {
        return;
      }
      answered = true;
      close();
      resolve(
        yes
          ? {
              backup: o.hasChanges && backupBox.checked,
              chip: chip.value as ChipId,
              kind,
              name: name.value.trim() || o.name,
            }
          : null
      );
    };
    const ok = h(
      "button",
      { class: "btn primary", onclick: () => answer(true) },
      o.okLabel
    );
    const rows = o.choose
      ? h(
          "div",
          { class: "choices", role: "radiogroup" },
          ...CHOICES.map((c) =>
            choiceRow(c, c.kind === kind, () => {
              ({ kind } = c);
              syncFields();
            })
          )
        )
      : null;
    syncFields();
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        answer(true);
      }
    });
    close = openModal(
      h(
        "div",
        { class: "confirm" },
        h("p", {}, o.message),
        rows,
        o.choose ? fields : null,
        backup,
        h(
          "div",
          { class: "confirm-btns" },
          h("button", { class: "btn", onclick: () => answer(false) }, "Cancel"),
          ok
        )
      ),
      { cls: "narrow", onClose: () => answer(false) }
    );
    ok.focus();
  });
}
