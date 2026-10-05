/* The 32 x 16 wavetable grid: draw a wave with the mouse (or finger), or start from a preset. */
import { clamp, h } from "../lib/dom.ts";
import { rgba } from "../visuals/canvas.ts";

export const TABLE_LEN = 32;
export const TABLE_MAX = 15;

export const PRESETS: Record<string, (i: number) => number> = {
  organ: (i) =>
    clamp(
      Math.round(
        7.5 +
          3.4 * Math.sin((2 * Math.PI * i) / 32) +
          2.4 * Math.sin((4 * Math.PI * i) / 32) +
          1.8 * Math.sin((8 * Math.PI * i) / 32)
      ),
      0,
      15
    ),
  saw: (i) => Math.round((i / 31) * 15),
  sine: (i) => Math.round(7.5 + 7.5 * Math.sin((2 * Math.PI * i) / TABLE_LEN)),
  square: (i) => (i < 16 ? 15 : 0),
  triangle: (i) =>
    Math.round(i < 16 ? (i / 15.5) * 15 : ((31 - i) / 15.5) * 15),
};

export const presetTable = (name: string): number[] =>
  Array.from(
    { length: TABLE_LEN },
    (_, i) => (PRESETS[name] ?? PRESETS.sine)?.(i) ?? 8
  );

export interface WaveGrid {
  el: HTMLElement;
  /** draw a moving marker while a note plays (0..1) */
  mark: (phase: number) => void;
  set: (table: readonly number[]) => void;
}

export function waveGrid(opts: {
  table: readonly number[];
  color: string;
  onChange: (table: number[]) => void;
  presets?: boolean;
}): WaveGrid {
  let table = [...opts.table];
  while (table.length < TABLE_LEN) {
    table.push(8);
  }
  const canvas = h("canvas", {
    "aria-label": "Wavetable: 32 steps, drag to draw",
    class: "wavegrid",
    height: 16 * 10,
    width: TABLE_LEN * 10,
  });
  const ctx = canvas.getContext("2d");
  let marker = -1;
  const draw = () => {
    if (!ctx) {
      return;
    }
    ctx.fillStyle = "#0e0d14";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (let x = 0; x < TABLE_LEN; x += 1) {
      const v = clamp(table[x] ?? 0, 0, TABLE_MAX);
      ctx.fillStyle =
        x % 2 === 0 ? "rgba(255,255,255,0.03)" : "rgba(255,255,255,0.0)";
      ctx.fillRect(x * 10, 0, 10, canvas.height);
      const top = (TABLE_MAX - v) * 10;
      ctx.fillStyle = rgba(opts.color, 0.38);
      ctx.fillRect(x * 10 + 1, top + 10, 8, canvas.height - top - 10);
      ctx.fillStyle = opts.color;
      ctx.fillRect(x * 10 + 1, top, 8, 9);
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.fillRect(x * 10 + 1, top, 8, 2);
    }
    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(0, 75, canvas.width, 1);
    if (marker >= 0) {
      ctx.fillStyle = "#ece7da";
      ctx.fillRect(Math.floor(marker * TABLE_LEN) * 10, 0, 2, canvas.height);
    }
  };
  let last = -1;
  let lastV = 0;
  const at = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = clamp(
      Math.floor(((e.clientX - r.left) / r.width) * TABLE_LEN),
      0,
      TABLE_LEN - 1
    );
    const v = clamp(
      TABLE_MAX - Math.floor(((e.clientY - r.top) / r.height) * 16),
      0,
      TABLE_MAX
    );
    return { v, x };
  };
  const paint = (e: PointerEvent) => {
    const { x, v } = at(e);
    if (last >= 0 && last !== x) {
      const a = Math.min(last, x);
      const b = Math.max(last, x);
      for (let i = a; i <= b; i += 1) {
        const t = b === a ? 1 : (i - last) / (x - last);
        table[i] = Math.round(lastV + (v - lastV) * clamp(t, 0, 1));
      }
    } else {
      table[x] = v;
    }
    last = x;
    lastV = v;
    draw();
    opts.onChange([...table]);
  };
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    last = -1;
    paint(e);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (e.buttons) {
      paint(e);
    }
  });
  canvas.addEventListener("pointerup", () => {
    last = -1;
  });
  const el = h("div", { class: "wavegrid-box" }, canvas);
  if (opts.presets !== false) {
    const row = h("div", { class: "btn-row" });
    for (const name of Object.keys(PRESETS)) {
      row.append(
        h(
          "button",
          {
            class: "btn small",
            onclick: () => {
              table = presetTable(name);
              draw();
              opts.onChange([...table]);
            },
          },
          name
        )
      );
    }
    el.append(row);
  }
  draw();
  return {
    el,
    mark(p) {
      marker = p;
      draw();
    },
    set(t) {
      table = [...t];
      draw();
    },
  };
}
