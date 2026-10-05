/* The FM instrument panel: the algorithm picker, feedback and LFO, and one compact strip per operator. The strips sit in
   a 2 x 2 grid (one column on a narrow screen) so all four operators are on screen together. */
import type { FmOperator, FmPatch, Instrument } from "../lib/contract.ts";
import { h } from "../lib/dom.ts";
import { type FieldHandle, rangeField, toggleField } from "./fields.ts";
import { algorithmSvg, drawOpEnvelope } from "./fm.ts";

/** What the panel needs from the editor around it. */
export interface FmPanelHost {
  /** Edit the instrument (one undo step per key while a slider is dragged). */
  edit: (fn: (d: Instrument) => void, key: string) => void;
  /** The patch's accent color. */
  hex: () => string;
  /** The instrument as it is now. */
  inst: () => Instrument;
  /** Whether the chip has a waveform select for operators, and the chip's name for the tooltip when it has not. */
  waveSelect: { chipName: string; ok: boolean };
}

const DEFAULT_LFO = { ampDepth: 0, pitchDepth: 10, rate: 5 };

function editFm(host: FmPanelHost, key: string, fn: (fm: FmPatch) => void) {
  host.edit((x) => {
    if (x.fm) {
      fn(x.fm);
    }
  }, key);
}

function algorithmPicker(host: FmPanelHost, fm: FmPatch, nOps: 2 | 4) {
  const row = h("div", {
    "aria-label": "FM algorithm",
    class: "alg-row",
    role: "radiogroup",
  });
  const choose = (a: number) => {
    editFm(host, "alg", (p) => {
      p.algorithm = a;
    });
    for (const el of row.querySelectorAll<HTMLElement>(".alg")) {
      const on = Number(el.dataset.a) === a;
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", String(on));
    }
  };
  for (let a = 0; a < (nOps === 2 ? 2 : 8); a += 1) {
    const b = h("button", {
      "aria-checked": String(a === fm.algorithm),
      class: `alg${a === fm.algorithm ? " on" : ""}`,
      "data-a": a,
      role: "radio",
      title: `Algorithm ${a}`,
    });
    b.innerHTML = `${algorithmSvg(a, nOps)}<small class="mono">${a}</small>`;
    b.addEventListener("click", () => choose(a));
    row.append(b);
  }
  return row;
}

/** Feedback, the LFO switch and the three LFO depths, on one line. */
function feedbackAndLfo(host: FmPanelHost, fm: FmPatch): HTMLElement {
  const top = h("div", { class: "fields micro roomy" });
  rangeField(top, {
    label: "Feedback",
    max: 7,
    min: 0,
    onInput: (v) =>
      editFm(host, "fb", (p) => {
        p.feedback = Math.round(v);
      }),
    step: 1,
    title: "How much operator 1 feeds back into itself",
    value: fm.feedback,
  });
  const depths: FieldHandle[] = [];
  toggleField(top, {
    label: "LFO",
    onInput: (on) => {
      editFm(host, "lfo", (p) => {
        p.lfo = on ? (p.lfo ?? { ...DEFAULT_LFO }) : null;
      });
      for (const d of depths) {
        d.setOff(on ? false : "Turn the LFO on first");
      }
    },
    value: fm.lfo !== null,
  });
  for (const [k, label, min, max, step] of [
    ["rate", "LFO rate (Hz)", 0, 20, 0.1],
    ["pitchDepth", "Pitch depth (cents)", 0, 100, 1],
    ["ampDepth", "Amp depth", 0, 1, 0.01],
  ] as const) {
    depths.push(
      rangeField(top, {
        label,
        max,
        min,
        off: fm.lfo ? false : "Turn the LFO on first",
        onInput: (v) =>
          editFm(host, `lfo${k}`, (p) => {
            if (p.lfo) {
              p.lfo[k] = v;
            }
          }),
        step,
        value: fm.lfo?.[k] ?? 0,
      })
    );
  }
  return top;
}

type RangeKey = Exclude<keyof FmOperator, "fixedHz">;

/** Label, key, min, max and step of each operator slider, three rows of four: the short labels keep a cell to one line,
 * the tooltip carries the full name. */
const OP_FIELDS: readonly {
  key: RangeKey;
  label: string;
  max: number;
  min: number;
  step: number;
  title: string;
}[] = [
  {
    key: "mult",
    label: "Multiple",
    max: 15,
    min: 0,
    step: 1,
    title: "Frequency multiple (0 means one half)",
  },
  { key: "detune", label: "Detune", max: 3, min: -3, step: 1, title: "Detune" },
  {
    key: "level",
    label: "Level",
    max: 1,
    min: 0,
    step: 0.01,
    title: "Output level (modulation depth for a modulator)",
  },
  {
    key: "keyScale",
    label: "Scaling",
    max: 3,
    min: 0,
    step: 1,
    title: "Key scaling: higher notes get faster envelopes",
  },
  {
    key: "attack",
    label: "Attack",
    max: 31,
    min: 0,
    step: 1,
    title: "Attack rate",
  },
  {
    key: "decay",
    label: "Decay",
    max: 31,
    min: 0,
    step: 1,
    title: "Decay rate",
  },
  {
    key: "sustainLevel",
    label: "Sustain",
    max: 1,
    min: 0,
    step: 0.01,
    title: "Sustain level",
  },
  {
    key: "sustainRate",
    label: "Sus rate",
    max: 31,
    min: 0,
    step: 1,
    title: "Sustain rate (the second decay)",
  },
  {
    key: "release",
    label: "Release",
    max: 15,
    min: 0,
    step: 1,
    title: "Release rate",
  },
  {
    key: "waveform",
    label: "Wave",
    max: 7,
    min: 0,
    step: 1,
    title: "Waveform",
  },
];

function opStrip(host: FmPanelHost, op: FmOperator, oi: number): HTMLElement {
  const cv = h("canvas", {
    "aria-label": `Operator ${oi + 1} envelope`,
    class: "op-env",
    height: 24,
    width: 80,
  });
  const fields = h("div", { class: "fields micro" });
  const strip = h(
    "div",
    { class: "op" },
    h("div", { class: "op-h" }, h("b", { class: "pxh" }, `Op ${oi + 1}`), cv),
    fields
  );
  const redraw = () => {
    const cur = host.inst().fm?.ops[oi];
    if (cur) {
      drawOpEnvelope(cv, cur, host.hex());
    }
  };
  const { chipName, ok } = host.waveSelect;
  for (const f of OP_FIELDS) {
    rangeField(fields, {
      label: f.label,
      max: f.max,
      min: f.min,
      off:
        f.key === "waveform" && !ok
          ? `${chipName} has no waveform select`
          : false,
      onInput: (v) => {
        editFm(host, `op${oi}${f.key}`, (p) => {
          const o = p.ops[oi];
          if (o) {
            o[f.key] = v;
          }
        });
        redraw();
      },
      step: f.step,
      title: f.title,
      value: op[f.key],
    });
  }
  toggleField(fields, {
    label: "Fixed Hz",
    onInput: (on) =>
      editFm(host, `op${oi}fixon`, (p) => {
        const o = p.ops[oi];
        if (o) {
          o.fixedHz = on ? (o.fixedHz ?? 440) : null;
        }
      }),
    value: op.fixedHz !== null,
  });
  requestAnimationFrame(redraw);
  return strip;
}

export function buildFmPanel(body: HTMLElement, host: FmPanelHost): void {
  const { fm } = host.inst();
  if (!fm) {
    return;
  }
  const nOps = fm.ops.length === 2 ? 2 : 4;
  body.append(
    algorithmPicker(host, fm, nOps),
    feedbackAndLfo(host, fm),
    h(
      "div",
      { class: "op-wrap" },
      h(
        "div",
        { class: "op-grid" },
        ...fm.ops.map((op, oi) => opStrip(host, op, oi))
      )
    )
  );
}
