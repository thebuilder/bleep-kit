/* Help for the song editor's tracker grid: the words behind an effect cell (hover text) and the "?" panel with the
   column layout, the entry keys, what the note off and release marks mean, and every effect of section 2.6. */
import type { Effect, EffectType } from "../lib/contract.ts";
import { formatEffect } from "../lib/core.ts";
import { h } from "../lib/dom.ts";
import { openModal } from "./modal.ts";

interface EffectHelp {
  /** What the effect does, one line. */
  about: string;
  /** An example code, and what it makes the sound do. */
  eg: [code: string, gloss: string];
  name: string;
  /** The code with its nibbles named, as in section 2.6. */
  pattern: string;
  /** The effect in words for the hover text, from its two nibbles. */
  say: (x: number, y: number) => string;
  type: EffectType;
}

const hex2 = (n: number) => n.toString(16).toUpperCase().padStart(2, "0");
const byteOf = (x: number, y: number) => x * 16 + y;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const panWord = (xx: number): string => {
  if (xx === 0x80) {
    return "center";
  }
  if (xx === 0) {
    return "hard left";
  }
  if (xx === 0xff) {
    return "hard right";
  }
  return xx < 0x80 ? "left" : "right";
};

/** The effects of section 2.6, in the order of that table. */
const EFFECTS: EffectHelp[] = [
  {
    about: "Cycle the note, +x and +y semitones, one step per tick. 000 stops.",
    eg: ["047", "major chord"],
    name: "Arpeggio",
    pattern: "0xy",
    say: (x, y) =>
      x === 0 && y === 0
        ? "arpeggio off"
        : `arpeggio, +${x} and +${y} semitones`,
    type: "arp",
  },
  {
    about: "Slide the pitch up, xx sixteenths of a semitone per tick.",
    eg: ["108", "half a semitone per tick"],
    name: "Slide up",
    pattern: "1xx",
    say: (x, y) =>
      byteOf(x, y) === 0
        ? "slide up off"
        : `slide up, ${byteOf(x, y)}/16 semitone per tick`,
    type: "slideUp",
  },
  {
    about: "Slide the pitch down, xx sixteenths of a semitone per tick.",
    eg: ["204", "a quarter semitone per tick"],
    name: "Slide down",
    pattern: "2xx",
    say: (x, y) =>
      byteOf(x, y) === 0
        ? "slide down off"
        : `slide down, ${byteOf(x, y)}/16 semitone per tick`,
    type: "slideDown",
  },
  {
    about:
      "Glide to each new note at xx sixteenths per tick. 300 turns it off.",
    eg: ["320", "a smooth glide between notes"],
    name: "Portamento",
    pattern: "3xx",
    say: (x, y) =>
      byteOf(x, y) === 0
        ? "portamento off"
        : `portamento, glide at ${byteOf(x, y)}/16 semitone per tick`,
    type: "portamento",
  },
  {
    about: "Wobble the pitch: speed x, depth y (8 cents each). 400 stops.",
    eg: ["446", "a medium wobble"],
    name: "Vibrato",
    pattern: "4xy",
    say: (x, y) =>
      x === 0 ? "vibrato off" : `vibrato, speed ${x}, depth ${y * 8} cents`,
    type: "vibrato",
  },
  {
    about: "Wobble the volume: speed x, depth y out of 15. 700 stops.",
    eg: ["748", "a fast, deep pulse"],
    name: "Tremolo",
    pattern: "7xy",
    say: (x, y) =>
      byteOf(x, y) === 0
        ? "tremolo off"
        : `tremolo, speed ${x}, depth ${y} of 15`,
    type: "tremolo",
  },
  {
    about: "Slide the volume up x or down y sixteenths per tick.",
    eg: ["A04", "a slow fade out"],
    name: "Volume slide",
    pattern: "Axy",
    say: (x, y) => {
      if (x === 0 && y === 0) {
        return "volume slide off";
      }
      if (y === 0) {
        return `volume slide up, ${x}/16 per tick`;
      }
      if (x === 0) {
        return `volume slide down, ${y}/16 per tick`;
      }
      return `volume slide, up ${x} and down ${y} sixteenths per tick`;
    },
    type: "volSlide",
  },
  {
    about: "After this row, continue at order step xx.",
    eg: ["B01", "loop back to step 01"],
    name: "Jump",
    pattern: "Bxx",
    say: (x, y) => `jump to order step ${hex2(byteOf(x, y))} after this row`,
    type: "jump",
  },
  {
    about: "Stop the song after this row.",
    eg: ["C00", "end the song here"],
    name: "Halt",
    pattern: "Cxx",
    say: () => "stop the song after this row",
    type: "halt",
  },
  {
    about: "After this row, continue at row xx of the next order step.",
    eg: ["D00", "cut this pattern short"],
    name: "Skip",
    pattern: "Dxx",
    say: (x, y) =>
      `skip to row ${hex2(byteOf(x, y))} of the next order step after this row`,
    type: "skip",
  },
  {
    about: "Set the tempo to xx BPM (hex, 20 to FF).",
    eg: ["F96", "150 BPM"],
    name: "Tempo",
    pattern: "Fxx",
    say: (x, y) => `set the tempo to ${byteOf(x, y)} BPM`,
    type: "tempo",
  },
  {
    about: "Pick the pulse duty, wave, SID waveform mask or FM algorithm.",
    eg: ["V02", "the third duty on a pulse channel"],
    name: "Duty",
    pattern: "Vxx",
    say: (x, y) =>
      `pick duty, wave, waveform or algorithm ${hex2(byteOf(x, y))}`,
    type: "duty",
  },
  {
    about: "Fine pitch offset: xx minus 80 sixteenths of a semitone, at once.",
    eg: ["P88", "half a semitone up"],
    name: "Pitch",
    pattern: "Pxx",
    say: (x, y) => {
      const d = byteOf(x, y) - 0x80;
      return d === 0
        ? "fine pitch, no offset"
        : `fine pitch ${d > 0 ? "+" : ""}${d}/16 semitone`;
    },
    type: "pitch",
  },
  {
    about: "Note off after xx ticks.",
    eg: ["S03", "a short staccato note"],
    name: "Cut",
    pattern: "Sxx",
    say: (x, y) => `note off after ${plural(byteOf(x, y), "tick")}`,
    type: "cut",
  },
  {
    about: "Trigger this row's note xx ticks late.",
    eg: ["G02", "a note a little behind the beat"],
    name: "Delay",
    pattern: "Gxx",
    say: (x, y) => `note starts ${plural(byteOf(x, y), "tick")} late`,
    type: "delay",
  },
  {
    about: "Slide up y semitones at speed x, then stay there.",
    eg: ["Q42", "up two semitones, quickly"],
    name: "Note slide up",
    pattern: "Qxy",
    say: (x, y) => `slide up ${plural(y, "semitone")} at speed ${x}`,
    type: "noteSlideUp",
  },
  {
    about: "Slide down y semitones at speed x, then stay there.",
    eg: ["R42", "down two semitones, quickly"],
    name: "Note slide down",
    pattern: "Rxy",
    say: (x, y) => `slide down ${plural(y, "semitone")} at speed ${x}`,
    type: "noteSlideDown",
  },
  {
    about: "Stereo position: 00 left, 80 center, FF right.",
    eg: ["X00", "all the way left"],
    name: "Pan",
    pattern: "Xxx",
    say: (x, y) => `pan ${panWord(byteOf(x, y))}`,
    type: "pan",
  },
  {
    about: "Echo send level, xx out of FF (chips with an echo).",
    eg: ["W80", "half send"],
    name: "Send",
    pattern: "Wxx",
    say: (x, y) => `echo send ${Math.round((byteOf(x, y) / 255) * 100)}%`,
    type: "send",
  },
  {
    about: "Retrigger the note every xx ticks until the next note.",
    eg: ["H04", "a fast repeat"],
    name: "Retrigger",
    pattern: "Hxx",
    say: (x, y) =>
      byteOf(x, y) === 0
        ? "retrigger off"
        : `retrigger every ${plural(byteOf(x, y), "tick")}`,
    type: "retrigger",
  },
];

const BY_TYPE = new Map(EFFECTS.map((e) => [e.type, e]));

/** The hover text of an empty effect cell. */
export const EMPTY_EFFECT_HINT = "type an effect code, e.g. 047";

/** Hover text of a filled effect cell: the code, then what it does in words ("047: arpeggio, +4 and +7 semitones"). */
export function describeEffect(e: Effect): string {
  const info = BY_TYPE.get(e.type);
  return `${formatEffect(e)}: ${info ? info.say(e.x, e.y) : e.type}`;
}

/** Hover text of a note cell that holds a note off or a release, "" for anything else. */
export function describeNote(note: unknown): string {
  if (note === "off") {
    return "note off: ends the note";
  }
  if (note === "release") {
    return "release: ends the note and lets it fade through its release";
  }
  return "";
}

const sample = (cls: string, text: string, style = "") =>
  h("span", { class: cls, style }, text);

function section(title: string, ...body: HTMLElement[]): HTMLElement {
  return h("section", { class: "th-sec" }, h("h4", {}, title), ...body);
}

function keys(...ks: string[]): HTMLElement {
  return h("span", { class: "th-keys" }, ...ks.map((k) => h("kbd", {}, k)));
}

function defList(rows: [HTMLElement | string, string][]): HTMLElement {
  const dl = h("div", { class: "th-list" });
  for (const [term, text] of rows) {
    dl.append(h("span", { class: "th-term" }, term), h("span", {}, text));
  }
  return dl;
}

function columnsSection(): HTMLElement {
  const demo = h(
    "div",
    { "aria-hidden": "true", class: "tc th-demo" },
    sample("n", "C-4"),
    sample("i", "01", "--ik:#7d97dc"),
    sample("v", "F"),
    sample("f", "047")
  );
  return section(
    "Columns",
    demo,
    defList([
      [sample("th-chip n", "C-4"), "Note. --- is empty."],
      [
        sample("th-chip i", "01", "--ik:#7d97dc"),
        "Instrument number, as listed in the inspector. Type two hex digits.",
      ],
      [
        sample("th-chip v", "F"),
        "Volume, one hex digit: 0 is silent, F is full.",
      ],
      [
        sample("th-chip f", "047"),
        "Effect: a letter or digit, then two hex digits. The fx button in a channel header adds a second effect column.",
      ],
    ])
  );
}

function entrySection(): HTMLElement {
  return section(
    "Entering notes",
    defList([
      [
        keys("Z", "S", "X", "D", "C", "V", "G", "B", "H", "N", "J", "M"),
        "The lower octave of notes.",
      ],
      [
        keys("Q", "2", "W", "3", "E", "R", "5", "T", "6", "Y", "7", "U"),
        "The upper octave.",
      ],
      [keys("-", "="), "Octave down and up."],
      [keys("1"), "Note off."],
      [keys("`"), "Release."],
      [
        keys("Delete"),
        "Clear the cell. Delete in the note column clears the whole row.",
      ],
      [
        keys("Arrows", "Tab"),
        "Move. Tab goes to the next column, Shift Tab back.",
      ],
    ])
  );
}

function symbolsSection(): HTMLElement {
  return section(
    "Marks in the note column",
    defList([
      [
        sample("th-chip n off", "==="),
        "Note off (the red mark). It ends the note on that channel, and continuous effects stop with it.",
      ],
      [
        sample("th-chip n rel", "^^^"),
        "Release. Like a note off, the note fades out through its release.",
      ],
      [
        sample("th-chip e", "---"),
        "Nothing on this row: whatever played goes on.",
      ],
    ])
  );
}

function effectsSection(): HTMLElement {
  const grid = h("div", { class: "th-fx" });
  for (const e of EFFECTS) {
    grid.append(
      sample("th-code", e.pattern),
      h(
        "span",
        {},
        h("b", {}, `${e.name}. `),
        e.about,
        h(
          "small",
          { class: "mono" },
          h("span", { class: "th-eg" }, e.eg[0]),
          ` ${e.eg[1]}`
        )
      )
    );
  }
  return section(
    "Adding an effect",
    h(
      "p",
      { class: "th-p" },
      "Move to the effect column of a row (click it, or Tab to it) and type three characters: the letter or digit, then two hex digits. 047 makes a major chord, A04 fades the note out. Delete clears it."
    ),
    h(
      "p",
      { class: "th-p" },
      "Arpeggio, vibrato, tremolo, volume slide, the slides, portamento and retrigger keep going until the same letter comes back with 00 (400 stops a vibrato) or a note off ends them. x and y are the two hex digits of the code, and xx means both together."
    ),
    grid
  );
}

/** Open the tracker help panel. */
export function openTrackerHelp(onClose: () => void): () => void {
  let close: () => void = () => undefined;
  const done = h(
    "button",
    { class: "btn", onclick: () => close(), type: "button" },
    "Close"
  );
  const body = h(
    "div",
    { class: "th-body" },
    columnsSection(),
    entrySection(),
    symbolsSection(),
    effectsSection(),
    h("div", { class: "th-foot" }, done)
  );
  close = openModal(
    h(
      "div",
      {},
      h(
        "div",
        { class: "pick-h" },
        h("span", { class: "pxh" }, "Tracker help"),
        h(
          "small",
          { class: "muted" },
          "Every channel is four columns, left to right: note, instrument, volume, effect."
        )
      ),
      body
    ),
    { cls: "wide", onClose }
  );
  done.focus({ preventScroll: true });
  return close;
}
