import { describe, expect, it } from "vitest";
import {
  interleavedToResult,
  mixToMono,
  resultToInterleaved,
} from "../../src/tools/buffers.ts";
import {
  ampToDb,
  formatDb,
  formatDuration,
  hzToNoteName,
  round,
} from "../../src/tools/format.ts";
import type { RenderResult } from "../../src/types.ts";
import { render } from "./helpers.ts";

const floats = (...values: number[]) => Float32Array.from(values);

function channels(planes: Float32Array[], frames: number): RenderResult {
  return { channels: planes, events: [], frames, sampleRate: 8000 };
}

describe("buffers", () => {
  it("interleaves stereo as L R L R and splits it back", () => {
    const r = render(48_000, floats(1, 2, 3), floats(4, 5, 6));
    const inter = resultToInterleaved(r);
    expect(Array.from(inter)).toEqual([1, 4, 2, 5, 3, 6]);
    const back = interleavedToResult(inter, 2, 44_100);
    expect(back.sampleRate).toBe(44_100);
    expect(back.frames).toBe(3);
    expect(back.events).toEqual([]);
    expect(back.channels.map((c) => Array.from(c))).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it("interleaves any channel count, and only as many frames as the render says it has", () => {
    const r = channels(
      [floats(1, 2, 3, 99), floats(4, 5, 6, 99), floats(7, 8, 9, 99)],
      3
    );
    expect(Array.from(resultToInterleaved(r))).toEqual([
      1, 4, 7, 2, 5, 8, 3, 6, 9,
    ]);
    expect(
      Array.from(resultToInterleaved(channels([floats(5, 6)], 2)))
    ).toEqual([5, 6]);
  });

  it("splits interleaved data by the channel count and drops a partial frame at the end", () => {
    const three = interleavedToResult(floats(1, 2, 3, 4, 5, 6, 7), 3, 8000);
    expect(three.frames).toBe(2);
    expect(three.channels.map((c) => Array.from(c))).toEqual([
      [1, 4],
      [2, 5],
      [3, 6],
    ]);
    const mono = interleavedToResult(floats(1, 2, 3), 1, 8000);
    expect(mono.channels.map((c) => Array.from(c))).toEqual([[1, 2, 3]]);
  });

  it("mixes to mono by averaging the channels", () => {
    const r = render(48_000, floats(1, 0, -1), floats(0, 1, -1));
    expect(Array.from(mixToMono(r))).toEqual([0.5, 0.5, -1]);
    // three channels are divided by three, and only r.frames samples are used
    const three = channels(
      [floats(0.3, 0.3, 9), floats(0.6, 0.6, 9), floats(0.9, 0.9, 9)],
      2
    );
    const mix = mixToMono(three);
    expect(mix).toHaveLength(2);
    expect(mix[0]).toBeCloseTo(0.6, 6);
    expect(mix[1]).toBeCloseTo(0.6, 6);
  });

  it("gives a mono render back as a separate copy, and silence for a render without channels", () => {
    const plane = floats(0.25, 0.5);
    const one = mixToMono(channels([plane], 2));
    expect(Array.from(one)).toEqual([0.25, 0.5]);
    one[0] = 1;
    expect(plane[0]).toBe(0.25);
    expect(Array.from(mixToMono(channels([], 3)))).toEqual([0, 0, 0]);
  });
});

describe("format", () => {
  it.each([
    [0, "0 ms"],
    [0.31, "310 ms"],
    [0.9994, "999 ms"],
    [1, "1.00 s"],
    [2.5, "2.50 s"],
    [59.5, "59.50 s"],
    [60, "1:00.0"],
    [65.2, "1:05.2"],
    [125.04, "2:05.0"],
    [600, "10:00.0"],
    [-3, "0 ms"],
    [Number.NaN, "-"],
    [Number.POSITIVE_INFINITY, "-"],
  ])("formats %f seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  // Known defect: the sub-unit is rounded after the unit was chosen, so values just under a boundary roll over wrongly
  // ("1:60.0" instead of "2:00.0", "1000 ms" instead of "1.00 s"). formatDuration is used in the image headers.
  // These pass while the defect exists (it.fails); when formatDuration is fixed they fail: turn them into plain it.
  it.fails("rolls 119.97 s over to 2:00.0, not 1:60.0", () => {
    expect(formatDuration(119.97)).toBe("2:00.0");
  });

  it.fails("rolls 59.999 s over to 1:00.0, not 60.00 s", () => {
    expect(formatDuration(59.999)).toBe("1:00.0");
  });

  it.fails("rolls 0.9996 s over to 1.00 s, not 1000 ms", () => {
    expect(formatDuration(0.9996)).toBe("1.00 s");
  });

  it.each([
    [-6.0206, 1, "-6.0 dB"],
    [-6.0206, 2, "-6.02 dB"],
    [3.14, 1, "3.1 dB"],
    [0, 1, "0.0 dB"],
    [-0.04, 1, "0.0 dB"], // never "-0.0"
    [-119.9, 1, "-119.9 dB"],
    [-120, 1, "-inf dB"], // the floor reads -inf
    [Number.NEGATIVE_INFINITY, 1, "-inf dB"],
  ])("formats %f dB with %i decimals as %s", (db, digits, text) => {
    expect(formatDb(db, digits)).toBe(text);
  });

  // Known defect: only the one-decimal "-0.0" is turned into "0.0", so two or more decimals still print a negative zero.
  it.fails("does not print a negative zero with two decimals", () => {
    expect(formatDb(-0.004, 2)).toBe("0.00 dB");
  });

  it("converts amplitude to dB, floored at -120", () => {
    expect(ampToDb(1)).toBe(0);
    expect(ampToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(ampToDb(0.1)).toBeCloseTo(-20, 6);
    expect(ampToDb(0)).toBe(-120);
    expect(ampToDb(1e-9)).toBe(-120);
    expect(ampToDb(-0.5)).toBe(-120);
  });

  it.each([
    [440, "A-4"],
    [261.63, "C-4"],
    [277.18, "C#4"],
    [27.5, "A-0"],
    [4186.01, "C-8"],
    [452, "A-4"], // nearest semitone: A#4 is at 466.16 Hz, the boundary is 452.9 Hz
    [454, "A#4"],
    [466.16, "A#4"],
  ])("names %f Hz %s", (hz, name) => {
    expect(hzToNoteName(hz)).toBe(name);
  });

  it("has no note name for zero, negative or missing frequencies", () => {
    expect(hzToNoteName(0)).toBeNull();
    expect(hzToNoteName(-5)).toBeNull();
    expect(hzToNoteName(Number.NaN)).toBeNull();
  });

  it("rounds to a number of decimals", () => {
    expect(round(1.234_56, 2)).toBe(1.23);
    expect(round(1.235_56, 2)).toBe(1.24);
    expect(round(5, 3)).toBe(5);
  });
});
