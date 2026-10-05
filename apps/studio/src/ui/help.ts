/* The shortcut sheet (?). */
import { h } from "../lib/dom.ts";
import { openModal } from "./modal.ts";

const SECTIONS: [string, [string, string][]][] = [
  [
    "Everywhere",
    [
      ["Space", "Play or pause the current thing"],
      ["Esc", "Stop everything"],
      ["Ctrl S", "Save"],
      ["Ctrl Z / Ctrl Shift Z", "Undo / redo"],
      ["Ctrl K", "Command palette"],
      ["[  ]", "Previous / next document"],
      ["Ctrl E", "Export"],
      ["Ctrl Shift A", "Analyse the current document"],
      ["?", "This sheet"],
    ],
  ],
  [
    "Pads",
    [
      ["1 2 3 ... 0", "Play the first ten pads"],
      ["Q W E ... P", "Play the next ten"],
      ["Dice on a pad", "Four mutations in a drawer"],
    ],
  ],
  [
    "Sound effect editor",
    [
      ["R", "Randomize (respects locked groups)"],
      ["M", "Mutate once"],
    ],
  ],
  [
    "Tracker",
    [
      ["Z S X D C V G B H N J M", "Notes, lower octave"],
      ["Q 2 W 3 E R 5 T 6 Y 7 U", "Notes, upper octave"],
      ["1  `", "Note off, release"],
      ["Arrows, Tab, Shift Tab", "Move"],
      ["PgUp  PgDn  Home  End", "Jump 16 rows, start, end"],
      ["Delete", "Clear the cell"],
      ["F", "Follow the playhead"],
    ],
  ],
];

export function openHelp(): void {
  const grid = h("div", { class: "help-grid" });
  for (const [title, rows] of SECTIONS) {
    grid.append(h("h4", {}, title));
    for (const [k, d] of rows) {
      grid.append(
        h(
          "span",
          {},
          ...k
            .split(" / ")
            .flatMap((x, i) =>
              i ? [" / ", h("kbd", {}, x)] : [h("kbd", {}, x)]
            )
        ),
        h("span", {}, d)
      );
    }
  }
  openModal(
    h(
      "div",
      {},
      h(
        "div",
        { class: "pick-h" },
        h("span", { class: "pxh" }, "Keyboard shortcuts")
      ),
      grid
    )
  );
}
