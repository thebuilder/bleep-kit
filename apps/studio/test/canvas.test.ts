/* The scope's two pure steps, worked by hand: where a trace starts (so a steady note stands still on screen) and where
   each sample lands on the canvas. The expected rows are worked out from the rule (full scale sits 2 px from the
   edge, silence on the middle line), not by running the function. */
import { describe, expect, it } from "vitest";
import { scopeTrace, triggerIndex } from "../src/visuals/canvas.ts";

const f32 = (...v: number[]) => Float32Array.of(...v);

describe("triggerIndex", () => {
  it("starts at the first place the wave rises through zero", () => {
    // 0.5 at the start is not a crossing; the climb from -0.1 to 0.2 at index 3 is
    expect(
      triggerIndex(f32(0.5, -0.5, -0.1, 0.2, 0.9, 0.4, -0.3, 0.1), 2)
    ).toBe(3);
  });

  it("counts a climb that leaves exactly zero", () => {
    expect(triggerIndex(f32(-0.5, 0, 0.5, 0.5, 0.5, 0.5), 2)).toBe(2);
  });

  it("ignores a crossing too close to the end for the window to fit, and a wave that never rises", () => {
    expect(triggerIndex(f32(-1, -1, -1, 1), 2)).toBe(0);
    expect(triggerIndex(f32(0, 0, 0, 0, 0, 0), 2)).toBe(0);
    expect(triggerIndex(f32(1, 1, 1, 1), 2)).toBe(0);
  });
});

describe("scopeTrace", () => {
  const rows = (spans: Int32Array) => Array.from(spans);

  it("puts full scale 2 px from the top and bottom and silence on the middle, each column reaching back to the last", () => {
    // 100 px tall: the middle is row 50, full scale up is row 2, full scale down row 98
    const { peak, spans } = scopeTrace(f32(1, -1, 0, 0.5), 0, 4, 4, 100);
    expect(rows(spans)).toEqual([2, 50, 2, 98, 50, 98, 26, 50]);
    expect(peak).toBe(1);
  });

  it("clamps samples beyond full scale", () => {
    const { peak, spans } = scopeTrace(f32(2.5, -3), 0, 2, 2, 100);
    expect(rows(spans)).toEqual([2, 50, 2, 98]);
    expect(peak).toBe(1);
  });

  it("draws a silent wave as the middle line with no peak", () => {
    const { peak, spans } = scopeTrace(new Float32Array(16), 0, 8, 4, 100);
    expect(rows(spans)).toEqual([50, 50, 50, 50, 50, 50, 50, 50]);
    expect(peak).toBe(0);
  });

  it("gives a wide canvas several columns per sample", () => {
    const { spans } = scopeTrace(f32(1, -1, 1, -1), 0, 4, 8, 100);
    expect(rows(spans).slice(0, 8)).toEqual([2, 50, 2, 2, 2, 98, 98, 98]);
  });

  it("reads from where the trigger put the start, and treats samples past the end as silence", () => {
    const { spans } = scopeTrace(f32(1, 1, -1), 2, 2, 2, 100);
    // column 0 is sample 2 (full scale down), column 1 is past the end of the data
    expect(rows(spans)).toEqual([50, 98, 50, 98]);
  });
});
