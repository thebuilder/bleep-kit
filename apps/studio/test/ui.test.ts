/* Drawing widgets worked directly: the macro bar editor (what a mouse stroke draws on every scale, the loop and release
   flags, presets, length) and the wavetable grid, plus which tick a macro is on over time. The canvas is a recording
   stub with a fixed size, so the geometry below is 300 x 80 for a macro (a 14 px ruler on top, the plot under it) and
   320 x 160 for the wavetable. */
import { describe, expect, it, vi } from "vitest";
import type { Macro } from "../src/lib/contract.ts";
import { type MacroScale, macroEditor, macroTick } from "../src/ui/macro.ts";
import { presetTable, waveGrid } from "../src/ui/wavegrid.ts";
import { installCanvasStub } from "./helpers.ts";

installCanvasStub();

/** A canvas laid out at 300 x 80 that accepts pointer capture. */
function sized(
  canvas: HTMLCanvasElement | null,
  w = 300,
  h = 80
): HTMLCanvasElement {
  const cv = canvas as HTMLCanvasElement;
  cv.getBoundingClientRect = () =>
    ({
      bottom: h,
      height: h,
      left: 0,
      right: w,
      top: 0,
      width: w,
      x: 0,
      y: 0,
    }) as DOMRect;
  cv.setPointerCapture = () => undefined;
  return cv;
}

const ptr = (
  cv: Element,
  type: string,
  x: number,
  y: number,
  extra: PointerEventInit = {}
) =>
  cv.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
      pointerId: 1,
      ...extra,
    })
  );

describe("macroTick", () => {
  const macro = (loop: number, release: number, n = 8): Macro => ({
    loop,
    release,
    values: Array.from({ length: n }, () => 1),
  });
  /** Milliseconds into the middle of tick `n`: macros advance 60 ticks a second. */
  const at = (n: number) => ((n + 0.5) / 60) * 1000;

  it("advances one tick every 1/60 s and stops on the last value without a loop", () => {
    expect(macroTick(macro(-1, -1), at(0))).toBe(0);
    expect(macroTick(macro(-1, -1), at(3))).toBe(3);
    expect(macroTick(macro(-1, -1), at(7))).toBe(7);
    expect(macroTick(macro(-1, -1), 5000)).toBe(7);
  });

  it("jumps back to the loop point after the last value", () => {
    // 0 1 2 3 4 5 6 7 2 3 4 5 6 7 2 ...
    expect(macroTick(macro(2, -1), at(8))).toBe(2);
    expect(macroTick(macro(2, -1), at(10))).toBe(4);
    expect(macroTick(macro(2, -1), at(14))).toBe(2);
  });

  it("cycles between the loop and release points while the note is held", () => {
    // 0 1 2 3 1 2 3 1 ...
    expect(macroTick(macro(1, 4), at(3))).toBe(3);
    expect(macroTick(macro(1, 4), at(4))).toBe(1);
    expect(macroTick(macro(1, 4), at(6))).toBe(3);
    expect(macroTick(macro(1, 4), at(7))).toBe(1);
  });

  it("holds the value before the release point when there is a release but no loop", () => {
    expect(macroTick(macro(-1, 4), at(3))).toBe(3);
    expect(macroTick(macro(-1, 4), at(9))).toBe(3);
  });

  it("continues from the release point once the note is released, then loops or holds the end", () => {
    // released at 500 ms: 4 5 6 7 then the end
    expect(macroTick(macro(-1, 4), 500, 60, 500)).toBe(4);
    expect(macroTick(macro(-1, 4), 500 + at(1), 60, 500)).toBe(5);
    expect(macroTick(macro(-1, 4), 500 + at(30), 60, 500)).toBe(7);
    // with a loop point after the release point: 4 5 6 7 5 6 7 5 ...
    expect(macroTick(macro(5, 4), 500 + at(2), 60, 500)).toBe(6);
    expect(macroTick(macro(5, 4), 500 + at(7), 60, 500)).toBe(5);
  });

  it("ignores a release for a macro that has no release point", () => {
    expect(macroTick(macro(-1, -1), 1000, 60, 500)).toBe(7);
    expect(macroTick(macro(2, -1), 1000, 60, 500)).toBe(
      macroTick(macro(2, -1), 1000)
    );
  });
});

describe("macroEditor", () => {
  // what the scale spans, and the size of one step the bars snap to
  const SCALES: Record<
    MacroScale,
    { hi: number; lo: number; neutral: number; step: number }
  > = {
    cents: { hi: 32, lo: -32, neutral: 0, step: 1 },
    index: { hi: 4, lo: 0, neutral: 0, step: 1 },
    pan: { hi: 1, lo: -1, neutral: 0, step: 0.125 },
    semi: { hi: 24, lo: -24, neutral: 0, step: 1 },
    // a volume macro is a 4 bit level, and switching one on must leave the sound as loud as it was
    unit: { hi: 1, lo: 0, neutral: 1, step: 1 / 15 },
  };
  // y positions on the 300 x 80 canvas: the ruler is the top 14 px, the plot the 66 under it
  const Y_TOP = 14;
  const Y_BOTTOM = 80;
  const Y_QUARTER_DOWN = 30.5;
  const X = [20, 100, 160, 280] as const;

  function mount(scale: MacroScale, macro?: Macro) {
    const changes: (Macro | undefined)[] = [];
    const ed = macroEditor({
      color: "#74c08f",
      macro,
      onChange: (m) => changes.push(m),
      spec: { max: 4, scale },
      title: "Test",
    });
    document.body.append(ed.el);
    const cv = sized(ed.el.querySelector("canvas"));
    const enable = ed.el.querySelector<HTMLInputElement>(
      'input[type="checkbox"]'
    ) as HTMLInputElement;
    const length = ed.el.querySelector<HTMLInputElement>(
      "input.len"
    ) as HTMLInputElement;
    const turnOn = () => {
      enable.checked = true;
      enable.dispatchEvent(new Event("change"));
    };
    const last = () => changes.at(-1) as Macro;
    return { changes, cv, ed, enable, last, length, turnOn };
  }

  for (const scale of Object.keys(SCALES) as MacroScale[]) {
    const { hi, lo, neutral, step } = SCALES[scale];

    describe(`on the ${scale} scale`, () => {
      it("starts a new macro neutral, and turning it off hands back nothing", () => {
        const m = mount(scale);
        m.turnOn();
        expect(m.last()).toEqual({
          loop: -1,
          release: -1,
          values: [neutral, neutral, neutral, neutral],
        });
        m.enable.checked = false;
        m.enable.dispatchEvent(new Event("change"));
        expect(m.last()).toBeUndefined();
      });

      it("draws the top of the plot as the highest value and the bottom as the lowest", () => {
        const m = mount(scale);
        m.turnOn();
        ptr(m.cv, "pointerdown", X[0], Y_TOP);
        ptr(m.cv, "pointerup", X[0], Y_TOP);
        ptr(m.cv, "pointerdown", X[1], Y_BOTTOM);
        ptr(m.cv, "pointerup", X[1], Y_BOTTOM);
        ptr(m.cv, "pointerdown", X[2], Y_QUARTER_DOWN);
        ptr(m.cv, "pointerup", X[2], Y_QUARTER_DOWN);
        const [a, b, c, d] = m.last().values;
        expect(a).toBeCloseTo(hi, 9);
        expect(b).toBeCloseTo(lo, 9);
        // a quarter of the way down the plot is 75% of the way up the range, to the nearest step
        expect(
          Math.abs((c as number) - (lo + 0.75 * (hi - lo)))
        ).toBeLessThanOrEqual(step / 2 + 1e-9);
        // the column nobody touched keeps its neutral value
        expect(d).toBeCloseTo(neutral, 9);
      });

      it("fills every column a fast drag jumps over, on a straight line, in whole steps", () => {
        const m = mount(scale);
        m.turnOn();
        ptr(m.cv, "pointerdown", X[0], Y_TOP);
        ptr(m.cv, "pointermove", X[3], Y_BOTTOM);
        ptr(m.cv, "pointerup", X[3], Y_BOTTOM);
        const { values } = m.last();
        expect(values).toHaveLength(4);
        for (const [k, v] of values.entries()) {
          const exact = hi + ((lo - hi) * k) / 3;
          expect(Math.abs(v - exact)).toBeLessThanOrEqual(step / 2 + 1e-9);
          // snapped to the scale's own steps, counted from its lowest value
          const steps = (v - lo) / step;
          expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
        }
        expect(values[0]).toBeCloseTo(hi, 9);
        expect(values[3]).toBeCloseTo(lo, 9);
      });
    });
  }

  it("draws the exact values a stroke covers, for a semitone macro", () => {
    const m = mount("semi");
    m.turnOn();
    ptr(m.cv, "pointerdown", X[0], Y_TOP);
    ptr(m.cv, "pointermove", X[3], Y_BOTTOM);
    ptr(m.cv, "pointerup", X[3], Y_BOTTOM);
    expect(m.last().values).toEqual([24, 8, -8, -24]);
  });

  it("reads out the column and value being drawn", () => {
    const m = mount("semi");
    m.turnOn();
    ptr(m.cv, "pointerdown", X[1], Y_TOP);
    expect(m.ed.el.querySelector(".ro")?.textContent).toBe("2: 24");
  });

  it("sets a loop point by clicking the ruler, clears it with a second click, and sets the release point with shift", () => {
    const m = mount("semi");
    m.turnOn();
    ptr(m.cv, "pointerdown", X[1], 3);
    ptr(m.cv, "pointerup", X[1], 3);
    expect(m.last()).toMatchObject({ loop: 1, release: -1 });
    ptr(m.cv, "pointerdown", X[1], 3);
    ptr(m.cv, "pointerup", X[1], 3);
    expect(m.last().loop).toBe(-1);
    ptr(m.cv, "pointerdown", X[1], 3, { shiftKey: true });
    ptr(m.cv, "pointerup", X[1], 3);
    expect(m.last()).toMatchObject({ loop: -1, release: 1 });
    // a flag can be dragged along the ruler
    ptr(m.cv, "pointerdown", X[1], 3, { shiftKey: true });
    ptr(m.cv, "pointermove", X[3], 3);
    ptr(m.cv, "pointerup", X[3], 3);
    expect(m.last().release).toBe(3);
  });

  it("clears a flag from its chip", () => {
    const m = mount("semi");
    m.turnOn();
    ptr(m.cv, "pointerdown", X[1], 3);
    ptr(m.cv, "pointerup", X[1], 3);
    ptr(m.cv, "pointerdown", X[2], 3, { shiftKey: true });
    ptr(m.cv, "pointerup", X[2], 3);
    expect(m.last()).toMatchObject({ loop: 1, release: 2 });
    const [loopChip, relChip] = Array.from(
      m.ed.el.querySelectorAll<HTMLElement>(".flagchip")
    );
    expect([loopChip?.textContent, relChip?.textContent]).toEqual([
      "Loop 2 x",
      "Release 3 x",
    ]);
    loopChip?.click();
    expect(m.last()).toMatchObject({ loop: -1, release: 2 });
    relChip?.click();
    expect(m.last()).toMatchObject({ loop: -1, release: -1 });
  });

  it("lengthens a macro by repeating its last value, and shortens it, dropping flags that fall off the end", () => {
    const m = mount("semi", { loop: 3, release: 2, values: [1, 2, 3, 4] });
    m.length.value = "6";
    m.length.dispatchEvent(new Event("change"));
    expect(m.last()).toEqual({
      loop: 3,
      release: 2,
      values: [1, 2, 3, 4, 4, 4],
    });
    m.length.value = "3";
    m.length.dispatchEvent(new Event("change"));
    expect(m.last()).toEqual({ loop: -1, release: 2, values: [1, 2, 3] });
    m.length.value = "0";
    m.length.dispatchEvent(new Event("change"));
    expect(m.last().values).toEqual([1]);
    m.length.value = "999";
    m.length.dispatchEvent(new Event("change"));
    expect(m.last().values).toHaveLength(256);
  });

  it("starts from a preset shape, keeping every value inside the scale and clearing the flags", () => {
    const arp = mount("semi", { loop: 1, release: 2, values: [0, 0, 0, 0] });
    const pick = (el: HTMLElement, name: string) => {
      const sel = el.querySelector("select") as HTMLSelectElement;
      sel.value = name;
      sel.dispatchEvent(new Event("change"));
    };
    pick(arp.ed.el, "Major arp");
    expect(arp.last()).toEqual({ loop: -1, release: -1, values: [0, 4, 7] });

    const fade = mount("unit", {
      loop: -1,
      release: -1,
      values: [1, 1, 1, 1, 1, 1],
    });
    pick(fade.ed.el, "Fade out");
    const { values } = fade.last();
    expect(values).toHaveLength(6);
    expect(values[0]).toBe(1);
    expect(
      values.every(
        (v, i) =>
          v >= 0 && v <= 1 && (i === 0 || v <= (values[i - 1] as number))
      )
    ).toBe(true);

    // the index scale of this editor tops out at 4 here, so the 0..3 cycle fits and a shape above it is cut
    const idxChanges: (Macro | undefined)[] = [];
    const idx = macroEditor({
      color: "#fff",
      macro: { loop: -1, release: -1, values: [0, 0] },
      onChange: (m) => idxChanges.push(m),
      spec: { max: 2, scale: "index" },
      title: "Idx",
    });
    pick(idx.el, "Cycle");
    expect(idxChanges.at(-1)?.values).toEqual([0, 1, 2, 2]);
  });

  it("takes a macro from outside without announcing it as an edit", () => {
    const m = mount("semi");
    m.ed.set({ loop: 1, release: 3, values: [0, 1, 0, 1, 0] });
    expect(m.changes).toEqual([]);
    expect(m.length.value).toBe("5");
    expect(m.enable.checked).toBe(true);
    m.ed.set(undefined);
    expect(m.enable.checked).toBe(false);
    expect(m.changes).toEqual([]);
  });

  it("ignores the mouse while it is greyed out", () => {
    const onChange = vi.fn();
    const ed = macroEditor({
      color: "#fff",
      macro: { loop: -1, release: -1, values: [1, 1] },
      off: "Not for this chip",
      onChange,
      spec: { scale: "unit" },
      title: "Off",
    });
    const cv = sized(ed.el.querySelector("canvas"));
    ptr(cv, "pointerdown", 20, 30);
    ptr(cv, "pointermove", 40, 30);
    expect(onChange).not.toHaveBeenCalled();
    expect(ed.el.title).toBe("Not for this chip");
  });
});

describe("waveGrid", () => {
  // 320 x 160: 32 columns of 10 px, 16 rows of 10 px, row 0 at the top is value 15
  const mount = (table: number[] = [1, 2, 3]) => {
    const changes: number[][] = [];
    const g = waveGrid({
      color: "#e0a050",
      onChange: (t) => changes.push(t),
      table,
    });
    document.body.append(g.el);
    const cv = sized(g.el.querySelector("canvas"), 320, 160);
    return { changes, cv, g };
  };

  it("draws a stroke across columns on a straight line, filling the ones it jumps over", () => {
    const { changes, cv } = mount();
    ptr(cv, "pointerdown", 10, 10);
    // pressing column 1 near the top: 15 - row 1 = 14; a short table is padded to 32 steps with the middle value
    expect(changes[0]).toEqual([
      1,
      14,
      3,
      ...Array.from({ length: 29 }, () => 8),
    ]);
    ptr(cv, "pointermove", 200, 120);
    ptr(cv, "pointerup", 200, 120);
    const t = changes.at(-1) as number[];
    expect(t).toHaveLength(32);
    // column 20, row 12 down is 15 - 12 = 3
    expect(t[1]).toBe(14);
    expect(t[20]).toBe(3);
    // 9 of the 19 columns between them in: 14 + (3 - 14) * 9 / 19, rounded
    expect(t[10]).toBe(9);
    for (let i = 2; i <= 20; i += 1) {
      expect(t[i] as number).toBeLessThanOrEqual(t[i - 1] as number);
    }
    // columns outside the stroke are left alone
    expect(t[0]).toBe(1);
    expect(t[21]).toBe(8);
  });

  it("stops drawing when the button is released", () => {
    const { changes, cv } = mount();
    ptr(cv, "pointerdown", 10, 10);
    ptr(cv, "pointerup", 10, 10);
    const n = changes.length;
    ptr(cv, "pointermove", 200, 120, { buttons: 0 });
    expect(changes).toHaveLength(n);
  });

  it("starts from a preset with the buttons, each a full 32 step wave inside 0 to 15", () => {
    const { changes, g } = mount();
    const named = (name: string) =>
      Array.from(g.el.querySelectorAll<HTMLElement>("button")).find(
        (b) => b.textContent === name
      ) as HTMLElement;
    for (const name of ["sine", "triangle", "saw", "square", "organ"]) {
      named(name).click();
      const t = changes.at(-1) as number[];
      expect(t, name).toHaveLength(32);
      expect(Math.min(...t), name).toBeGreaterThanOrEqual(0);
      expect(Math.max(...t), name).toBeLessThanOrEqual(15);
    }
    named("square").click();
    expect(changes.at(-1)).toEqual([
      ...Array.from({ length: 16 }, () => 15),
      ...Array.from({ length: 16 }, () => 0),
    ]);
    named("saw").click();
    const saw = changes.at(-1) as number[];
    expect(saw[0]).toBe(0);
    expect(saw[31]).toBe(15);
    expect(saw.every((v, i) => i === 0 || v >= (saw[i - 1] as number))).toBe(
      true
    );
    named("sine").click();
    const sine = changes.at(-1) as number[];
    expect(sine[8]).toBe(15);
    expect(sine[24]).toBe(0);
    named("triangle").click();
    const tri = changes.at(-1) as number[];
    expect([tri[0], tri[31]]).toEqual([0, 0]);
    expect(Math.max(...tri)).toBe(15);
    expect(tri.indexOf(15)).toBeGreaterThanOrEqual(14);
    expect(tri.indexOf(15)).toBeLessThanOrEqual(16);
  });

  it("draws on top of a table set from outside, such as an undo", () => {
    const { changes, cv, g } = mount();
    g.set(Array.from({ length: 32 }, (_, i) => i % 16));
    ptr(cv, "pointerdown", 5, 0);
    ptr(cv, "pointerup", 5, 0);
    const t = changes.at(-1) as number[];
    expect(t[0]).toBe(15);
    expect(t.slice(1)).toEqual(
      Array.from({ length: 31 }, (_, i) => (i + 1) % 16)
    );
    expect(changes).toHaveLength(1);
  });

  it("can leave the presets out", () => {
    const g = waveGrid({
      color: "#fff",
      onChange: () => undefined,
      presets: false,
      table: presetTable("square"),
    });
    expect(g.el.querySelector("button")).toBeNull();
  });
});
