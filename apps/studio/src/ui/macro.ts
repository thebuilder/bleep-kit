/* A macro bar editor: one bar per tick, drawn with the mouse, with loop and release flags you can drag. Used for the
   volume, arpeggio, pitch, duty and pan macros of an instrument. */
import type { Macro } from "../lib/contract.ts";
import { choose, clamp, h } from "../lib/dom.ts";
import { rgba, type Surface, surface } from "../visuals/canvas.ts";

export type MacroScale = "unit" | "semi" | "cents" | "index" | "pan";

export interface MacroSpec {
  /** for "index": highest index */
  max?: number;
  scale: MacroScale;
}

export const macroRange = (
  s: MacroSpec
): { lo: number; hi: number; step: number; neutral: number; dflt: number } => {
  switch (s.scale) {
    case "unit":
      return { dflt: 1, hi: 1, lo: 0, neutral: 0, step: 1 / 15 };
    case "semi":
      return { dflt: 0, hi: 24, lo: -24, neutral: 0, step: 1 };
    case "cents":
      return { dflt: 0, hi: 32, lo: -32, neutral: 0, step: 1 };
    case "pan":
      return { dflt: 0, hi: 1, lo: -1, neutral: 0, step: 0.125 };
    default:
      return { dflt: 0, hi: s.max ?? 3, lo: 0, neutral: 0, step: 1 };
  }
};

const PRESETS: Record<MacroScale, Record<string, (n: number) => number[]>> = {
  cents: {
    Dive: () => [0, -2, -4, -6, -8, -10, -12, -14],
    Flat: () => [0],
    Vibrato: () => [0, 4, 8, 4, 0, -4, -8, -4],
  },
  index: {
    Cycle: () => [0, 1, 2, 3],
    Flat: () => [0],
    Ping: () => [0, 1, 2, 3, 2, 1],
  },
  pan: {
    Centre: () => [0],
    Sweep: () => [-1, -0.5, 0, 0.5, 1, 0.5, 0, -0.5],
  },
  semi: {
    Flat: () => [0],
    "Major arp": () => [0, 4, 7],
    "Minor arp": () => [0, 3, 7],
    Octave: () => [0, 12],
  },
  unit: {
    "Fade in": (n) =>
      Array.from(
        { length: Math.max(2, n) },
        (_, i) => Math.round((i / (Math.max(2, n) - 1)) * 15) / 15
      ),
    "Fade out": (n) =>
      Array.from(
        { length: Math.max(2, n) },
        (_, i) => Math.round((1 - i / Math.max(2, n)) * 15) / 15
      ),
    Pluck: () => [1, 0.8, 0.6, 0.47, 0.33, 0.27, 0.2, 0.13, 0.07, 0],
    Tremolo: () => [1, 0.8, 0.6, 0.8, 1, 0.8, 0.6, 0.8],
  },
};

export interface MacroEditor {
  dispose: () => void;
  draw: () => void;
  el: HTMLElement;
  /** a 0-based tick to mark as "playing now", or -1 */
  mark: (tick: number) => void;
  set: (m: Macro | undefined) => void;
}

export interface MacroOpts {
  color: string;
  /** text of a bar value, for the readout */
  format?: (v: number) => string;
  hint?: string;
  macro: Macro | undefined;
  /** greyed with this reason */
  off?: string | false;
  onChange: (m: Macro | undefined) => void;
  spec: MacroSpec;
  title: string;
}

const emptyMacro = (spec: MacroSpec): Macro => ({
  loop: -1,
  release: -1,
  values: [
    macroRange(spec).dflt,
    macroRange(spec).dflt,
    macroRange(spec).dflt,
    macroRange(spec).dflt,
  ],
});

export function macroEditor(o: MacroOpts): MacroEditor {
  let macro: Macro | undefined = o.macro
    ? { ...o.macro, values: [...o.macro.values] }
    : undefined;
  const r = macroRange(o.spec);
  const canvas = h("canvas", {
    "aria-label": `${o.title} macro: drag to draw`,
    class: "macro-cv",
  });
  let surf: Surface | null = null;
  let marked = -1;

  const enable = h("input", {
    "aria-label": `Use the ${o.title} macro`,
    type: "checkbox",
  }) as HTMLInputElement;
  const lenIn = h("input", {
    "aria-label": `${o.title} length`,
    class: "len",
    max: 256,
    min: 1,
    type: "number",
  }) as HTMLInputElement;
  const readout = h("span", { class: "mono ro" });
  const loopChip = h("button", {
    class: "btn small flagchip",
    title:
      "Loop flag: the sequence jumps back here after its last value. Click a bar number in the ruler to set it",
  });
  const relChip = h("button", {
    class: "btn small flagchip rel",
    title:
      "Release flag: the sequence jumps here when the note is released. Shift-click the ruler to set it",
  });
  const presetSel = h("select", {
    "aria-label": `${o.title} presets`,
    class: "preset",
  }) as HTMLSelectElement;
  presetSel.append(h("option", { value: "" }, "Shape..."));
  for (const k of Object.keys(PRESETS[o.spec.scale])) {
    presetSel.append(h("option", { value: k }, k));
  }
  const tgl = h("span", { class: "tgl" }, enable, h("span", {}));
  const headRow = h(
    "div",
    { class: "macro-h" },
    tgl,
    h("b", { class: "pxh" }, o.title),
    readout
  );
  const tools = h(
    "div",
    { class: "macro-t" },
    h("label", { class: "inl" }, "Length", lenIn),
    loopChip,
    relChip,
    presetSel
  );
  const body = h("div", { class: "macro-b" }, canvas);
  const el = h("div", { class: "macro" }, headRow, tools, body);
  if (o.hint) {
    headRow.title = o.hint;
  }

  const commit = (m: Macro | undefined) => {
    macro = m;
    o.onChange(m ? { ...m, values: [...m.values] } : undefined);
    sync();
    draw();
  };

  function sync(): void {
    const on = !!macro;
    enable.checked = on;
    el.classList.toggle("dis", !on);
    lenIn.value = String(macro?.values.length ?? 0);
    lenIn.disabled = !on || !!o.off;
    presetSel.disabled = !on || !!o.off;
    loopChip.hidden = !on;
    relChip.hidden = !on;
    loopChip.textContent =
      macro && macro.loop >= 0 ? `Loop ${macro.loop + 1} x` : "Loop off";
    relChip.textContent =
      macro && macro.release >= 0
        ? `Release ${macro.release + 1} x`
        : "Release off";
    loopChip.classList.toggle("on", !!macro && macro.loop >= 0);
    relChip.classList.toggle("on", !!macro && macro.release >= 0);
    el.classList.toggle("off", !!o.off);
    if (o.off) {
      el.title = String(o.off);
    }
    enable.disabled = !!o.off;
  }

  enable.addEventListener("change", () =>
    commit(enable.checked ? (macro ?? emptyMacro(o.spec)) : undefined)
  );
  lenIn.addEventListener("keydown", (e) => e.stopPropagation());
  lenIn.addEventListener("change", () => {
    if (!macro) {
      return;
    }
    const n = clamp(Math.round(Number(lenIn.value) || 1), 1, 256);
    const vals = [...macro.values];
    while (vals.length < n) {
      vals.push(vals.at(-1) ?? r.dflt);
    }
    vals.length = n;
    commit({
      loop: macro.loop < n ? macro.loop : -1,
      release: macro.release < n ? macro.release : -1,
      values: vals,
    });
  });
  loopChip.addEventListener(
    "click",
    () => macro && macro.loop >= 0 && commit({ ...macro, loop: -1 })
  );
  relChip.addEventListener(
    "click",
    () => macro && macro.release >= 0 && commit({ ...macro, release: -1 })
  );
  presetSel.addEventListener("change", () => {
    const fn = PRESETS[o.spec.scale][presetSel.value];
    presetSel.value = "";
    if (fn && macro) {
      const vals = fn(macro.values.length).map((v) => clamp(v, r.lo, r.hi));
      commit({ loop: -1, release: -1, values: vals });
    }
  });

  /* drawing with the mouse */
  const RULER = 14;
  const geo = () => {
    const w = surf?.w ?? 300;
    const hh = surf?.h ?? 80;
    const n = macro?.values.length ?? 1;
    return { cw: w / n, h: hh, n, ph: hh - RULER, top: RULER, w };
  };
  const colOf = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    const g = geo();
    return {
      g,
      i: clamp(
        Math.floor(((e.clientX - rect.left) / rect.width) * g.n),
        0,
        g.n - 1
      ),
      y: e.clientY - rect.top,
    };
  };
  const valueAt = (y: number, g: ReturnType<typeof geo>) => {
    const t = 1 - clamp((y - g.top) / g.ph, 0, 1);
    const raw = r.lo + t * (r.hi - r.lo);
    return clamp(Math.round(raw / r.step) * r.step, r.lo, r.hi);
  };
  let last = -1;
  let lastV = 0;
  let dragFlag: "loop" | "release" | null = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (!macro || o.off) {
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    const { i, y, g } = colOf(e);
    if (y < g.top) {
      const which = e.shiftKey || macro.release === i ? "release" : "loop";
      dragFlag = which;
      commit({
        ...macro,
        [which]: macro[which] === i && !e.shiftKey && which === "loop" ? -1 : i,
      });
      return;
    }
    last = -1;
    paint(e);
  });
  const paint = (e: PointerEvent) => {
    if (!macro) {
      return;
    }
    const { i, y, g } = colOf(e);
    const v = valueAt(y, g);
    const vals = [...macro.values];
    if (last >= 0 && last !== i) {
      const a = Math.min(last, i);
      const b = Math.max(last, i);
      for (let k = a; k <= b; k += 1) {
        const t = clamp((k - last) / (i - last), 0, 1);
        vals[k] = clamp(
          Math.round((lastV + (v - lastV) * t) / r.step) * r.step,
          r.lo,
          r.hi
        );
      }
    } else {
      vals[i] = v;
    }
    last = i;
    lastV = v;
    macro = { ...macro, values: vals };
    o.onChange({ ...macro, values: [...vals] });
    readout.textContent = `${i + 1}: ${(o.format ?? ((x) => String(Math.round(x * 100) / 100)))(v)}`;
    draw();
  };
  canvas.addEventListener("pointermove", (e) => {
    if (!macro || o.off) {
      return;
    }
    if (dragFlag && e.buttons) {
      const { i } = colOf(e);
      if (macro[dragFlag] !== i) {
        macro = { ...macro, [dragFlag]: i };
        o.onChange({ ...macro, values: [...macro.values] });
        sync();
        draw();
      }
      return;
    }
    if (e.buttons) {
      paint(e);
    }
  });
  const up = () => {
    last = -1;
    dragFlag = null;
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  function draw(): void {
    if (!surf) {
      return;
    }
    surf.fit();
    const { ctx, w, h: hh } = surf;
    ctx.clearRect(0, 0, w, hh);
    ctx.fillStyle = "#0e0d14";
    ctx.fillRect(0, 0, w, hh);
    if (!macro) {
      ctx.fillStyle = "#5b566a";
      ctx.font = '11px "Atkinson Hyperlegible", sans-serif';
      ctx.textBaseline = "middle";
      ctx.fillText(
        "Off. Turn the macro on to draw one value per tick.",
        10,
        hh / 2
      );
      return;
    }
    const g = geo();
    const barBottom = hh - 1;
    const zeroY = g.top + g.ph * (1 - (r.neutral - r.lo) / (r.hi - r.lo));
    // grid
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    for (let k = 1; k < 4; k += 1) {
      ctx.fillRect(0, Math.floor(g.top + (g.ph * k) / 4), w, 1);
    }
    for (let i = 0; i < g.n; i += 1) {
      const v = clamp(macro.values[i] ?? 0, r.lo, r.hi);
      const x0 = Math.floor(i * g.cw);
      const x1 = Math.max(
        x0 + 1,
        Math.floor((i + 1) * g.cw) - (g.cw > 4 ? 1 : 0)
      );
      const y = Math.round(g.top + g.ph * (1 - (v - r.lo) / (r.hi - r.lo)));
      const inLoop = macro.loop >= 0 && i >= macro.loop;
      const isMark = i === marked;
      const from = r.lo < 0 ? zeroY : barBottom;
      const top = Math.min(y, from);
      const bot = Math.max(y, from);
      ctx.fillStyle = choose(
        [
          [isMark, "#ece7da"],
          [inLoop, o.color],
        ],
        rgba(o.color, 0.78)
      );
      ctx.fillRect(x0, top, x1 - x0, Math.max(2, bot - top));
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.fillRect(x0, y, x1 - x0, 1);
    }
    if (r.lo < 0) {
      ctx.fillStyle = "rgba(255,255,255,0.22)";
      ctx.fillRect(0, Math.floor(zeroY), w, 1);
    }
    // ruler and flags
    ctx.fillStyle = "#16151f";
    ctx.fillRect(0, 0, w, RULER - 2);
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const every = choose(
      [
        [g.cw >= 18, 1],
        [g.cw >= 8, 4],
        [g.cw >= 4, 8],
      ],
      16
    );
    for (let i = 0; i < g.n; i += every) {
      ctx.fillStyle = "#5b566a";
      ctx.fillText(String(i + 1), Math.floor(i * g.cw) + 2, 6);
    }
    const flag = (i: number, col: string, ch: string) => {
      if (i < 0 || i >= g.n) {
        return;
      }
      const x = Math.floor(i * g.cw);
      ctx.fillStyle = col;
      ctx.fillRect(x, 0, Math.max(2, Math.min(10, g.cw)), RULER - 2);
      ctx.fillRect(x, 0, 2, hh);
      ctx.fillStyle = "#121119";
      ctx.textAlign = "left";
      ctx.fillText(ch, x + 2, 6);
    };
    flag(macro.loop, "#74c08f", "L");
    flag(macro.release, "#dc7ba4", "R");
  }

  const mounted = () => {
    surf ??= surface(canvas);
    draw();
  };
  // the canvas needs layout before it has a size, so draw on the next frames
  requestAnimationFrame(() => requestAnimationFrame(mounted));
  sync();
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => draw());
    ro.observe(body);
  }

  return {
    dispose() {
      surf?.dispose();
    },
    draw,
    el,
    mark(t) {
      if (t !== marked) {
        marked = t;
        draw();
      }
    },
    set(m) {
      macro = m ? { ...m, values: [...m.values] } : undefined;
      sync();
      draw();
    },
  };
}

/** The tick a macro is on, `ms` after a note starts (held) or after it was released at `releaseMs`. */
export function macroTick(
  m: Macro,
  ms: number,
  tickRate = 60,
  releasedAfterMs: number | null = null
): number {
  const n = m.values.length;
  let i = Math.floor((ms / 1000) * tickRate);
  if (releasedAfterMs !== null && m.release >= 0) {
    i = m.release + Math.floor(((ms - releasedAfterMs) / 1000) * tickRate);
  } else if (m.release >= 0 && i >= m.release) {
    i =
      m.loop >= 0 && m.loop < m.release
        ? m.loop + ((i - m.loop) % Math.max(1, m.release - m.loop))
        : m.release - 1;
  }
  if (i >= n) {
    i = m.loop >= 0 ? m.loop + ((i - m.loop) % Math.max(1, n - m.loop)) : n - 1;
  }
  return clamp(i, 0, n - 1);
}
