/* Drawing widgets worked directly: the macro bar editor (every scale, mouse drawing, flags, presets, length) and the
   wavetable grid, plus which tick a macro is on over time. The canvas is a recording stub with a fixed size. */
import { describe, expect, it, vi } from "vitest";
import type { Macro } from "../src/lib/contract.ts";
import { type MacroScale, macroEditor, macroTick } from "../src/ui/macro.ts";
import { presetTable, waveGrid } from "../src/ui/wavegrid.ts";
import { installCanvasStub, settle } from "./helpers.ts";

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
  const m = (loop: number, release: number, n = 8): Macro => ({
    loop,
    release,
    values: Array.from({ length: n }, () => 1),
  });

  it("walks forward one tick every 1/60 s and stops on the last value without a loop", () => {
    expect(macroTick(m(-1, -1), 0)).toBe(0);
    expect(macroTick(m(-1, -1), 50)).toBe(3);
    expect(macroTick(m(-1, -1), 5000)).toBe(7);
  });

  it("wraps to the loop point", () => {
    expect(macroTick(m(2, -1), (10 / 60) * 1000)).toBe(2 + ((10 - 2) % 6));
  });

  it("loops inside a loop and release pair while the note is held, and holds the release point's predecessor without a loop", () => {
    expect(macroTick(m(1, 4), (6 / 60) * 1000)).toBe(1 + ((6 - 1) % 3));
    expect(macroTick(m(-1, 4), (9 / 60) * 1000)).toBe(3);
  });

  it("continues from the release point after the note is released", () => {
    expect(macroTick(m(-1, 4), 1000, 60, 500)).toBe(7);
    expect(macroTick(m(5, 4), (2 / 60) * 1000 + 500, 60, 500)).toBe(6);
  });
});

describe("macroEditor", () => {
  const scales: MacroScale[] = ["unit", "semi", "cents", "index", "pan"];

  for (const scale of scales) {
    it(`draws, flags, shapes and resizes a ${scale} macro`, async () => {
      const changes: (Macro | undefined)[] = [];
      const ed = macroEditor({
        color: "#74c08f",
        hint: "a hint",
        macro: undefined,
        onChange: (m) => changes.push(m),
        spec: { max: 5, scale },
        title: "Test",
      });
      document.body.append(ed.el);
      const cv = sized(ed.el.querySelector("canvas"));
      const enable = ed.el.querySelector<HTMLInputElement>(
        'input[type="checkbox"]'
      ) as HTMLInputElement;
      enable.checked = true;
      enable.dispatchEvent(new Event("change"));
      expect(changes.at(-1)?.values.length).toBe(4);
      await settle(30);

      ptr(cv, "pointerdown", 20, 30);
      ptr(cv, "pointermove", 140, 70);
      ptr(cv, "pointermove", 280, 5);
      ptr(cv, "pointerup", 280, 5);
      expect(ed.el.querySelector(".ro")?.textContent).toMatch(/^\d+: /);

      // the ruler sets a loop point, a second click on it clears it, shift sets the release point
      ptr(cv, "pointerdown", 80, 3);
      ptr(cv, "pointerup", 80, 3);
      expect(changes.at(-1)?.loop).toBe(1);
      ptr(cv, "pointerdown", 80, 3);
      ptr(cv, "pointerup", 80, 3);
      expect(changes.at(-1)?.loop).toBe(-1);
      ptr(cv, "pointerdown", 160, 3, { shiftKey: true });
      ptr(cv, "pointermove", 220, 3);
      ptr(cv, "pointermove", 220, 3);
      ptr(cv, "pointerup", 220, 3);
      expect(changes.at(-1)?.release).toBe(2);
      const [loopChip, relChip] = Array.from(
        ed.el.querySelectorAll<HTMLElement>(".flagchip")
      );
      ptr(cv, "pointerdown", 40, 3);
      ptr(cv, "pointerup", 40, 3);
      loopChip?.click();
      relChip?.click();
      expect(changes.at(-1)).toMatchObject({ loop: -1, release: -1 });

      const len = ed.el.querySelector<HTMLInputElement>(
        "input.len"
      ) as HTMLInputElement;
      len.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "a" })
      );
      len.value = "12";
      len.dispatchEvent(new Event("change"));
      expect(changes.at(-1)?.values.length).toBe(12);
      len.value = "2";
      len.dispatchEvent(new Event("change"));
      expect(changes.at(-1)?.values.length).toBe(2);

      const sel = ed.el.querySelector("select") as HTMLSelectElement;
      for (const o of Array.from(sel.options).slice(1)) {
        sel.value = o.value;
        sel.dispatchEvent(new Event("change"));
        expect(changes.at(-1)?.values.length).toBeGreaterThan(0);
      }

      ed.mark(1);
      ed.mark(1);
      ed.set({ loop: 1, release: 3, values: [0, 1, 0, 1, 0] });
      ed.set(undefined);
      ptr(cv, "pointerdown", 20, 30);
      enable.checked = false;
      enable.dispatchEvent(new Event("change"));
      expect(changes.at(-1)).toBeUndefined();
      ed.dispose();
      ed.el.remove();
    });
  }

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
  it("draws by dragging, starts from presets and follows a marker", () => {
    const changes: number[][] = [];
    const g = waveGrid({
      color: "#e0a050",
      onChange: (t) => changes.push(t),
      table: [1, 2, 3],
    });
    document.body.append(g.el);
    const cv = sized(g.el.querySelector("canvas"), 320, 160);
    ptr(cv, "pointerdown", 10, 10);
    ptr(cv, "pointermove", 200, 120);
    ptr(cv, "pointermove", 20, 30);
    ptr(cv, "pointermove", 20, 30, { buttons: 0 });
    ptr(cv, "pointerup", 20, 30);
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.at(-1)?.length).toBe(32);
    for (const b of g.el.querySelectorAll<HTMLElement>("button")) {
      b.click();
    }
    expect(changes.at(-1)).toEqual(presetTable("triangle"));
    g.mark(0.5);
    g.set(presetTable("saw"));
    expect(presetTable("nope")).toEqual(presetTable("sine"));
    g.el.remove();
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
