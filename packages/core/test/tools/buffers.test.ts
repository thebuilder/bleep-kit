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
import { render } from "./helpers.ts";

describe("buffers", () => {
  it("interleaves and splits channels", () => {
    const r = render(
      48_000,
      Float32Array.from([1, 2, 3]),
      Float32Array.from([4, 5, 6])
    );
    const inter = resultToInterleaved(r);
    expect(Array.from(inter)).toEqual([1, 4, 2, 5, 3, 6]);
    const back = interleavedToResult(inter, 2, 44_100);
    expect(back.sampleRate).toBe(44_100);
    expect(back.frames).toBe(3);
    expect(back.events).toEqual([]);
    expect(Array.from(back.channels[0] ?? [])).toEqual([1, 2, 3]);
    expect(Array.from(back.channels[1] ?? [])).toEqual([4, 5, 6]);
  });

  it("handles mono, other counts and a ragged tail", () => {
    expect(
      interleavedToResult(Float32Array.from([1, 2, 3]), 1, 8000).channels
    ).toHaveLength(1);
    const three = interleavedToResult(
      Float32Array.from([1, 2, 3, 4, 5, 6, 7]),
      3,
      8000
    );
    expect(three.channels).toHaveLength(3);
    expect(three.frames).toBe(2);
  });

  it("mixes to mono by averaging", () => {
    const r = render(
      48_000,
      Float32Array.from([1, 0, -1]),
      Float32Array.from([0, 1, -1])
    );
    expect(Array.from(mixToMono(r))).toEqual([0.5, 0.5, -1]);
    const one = mixToMono({
      channels: [Float32Array.from([0.25, 0.5])],
      events: [],
      frames: 2,
      sampleRate: 8000,
    });
    expect(Array.from(one)).toEqual([0.25, 0.5]);
    expect(
      mixToMono({ channels: [], events: [], frames: 3, sampleRate: 8000 })
    ).toHaveLength(3);
  });
});

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(0.31)).toBe("310 ms");
    expect(formatDuration(2.5)).toBe("2.50 s");
    expect(formatDuration(65.25)).toBe("1:05.3");
    expect(formatDuration(600)).toBe("10:00.0");
    expect(formatDuration(Number.NaN)).toBe("-");
    expect(formatDuration(-3)).toBe("0 ms");
  });

  it("formats decibels", () => {
    expect(formatDb(-6.0206)).toBe("-6.0 dB");
    expect(formatDb(-6.0206, 2)).toBe("-6.02 dB");
    expect(formatDb(0)).toBe("0.0 dB");
    expect(formatDb(-0.04)).toBe("0.0 dB");
    expect(formatDb(-120)).toBe("-inf dB");
    expect(formatDb(Number.NEGATIVE_INFINITY)).toBe("-inf dB");
    expect(formatDb(3.14)).toBe("3.1 dB");
  });

  it("converts amplitude to dB with a floor and names notes", () => {
    expect(ampToDb(1)).toBe(0);
    expect(ampToDb(0.5)).toBeCloseTo(-6.02, 2);
    expect(ampToDb(0)).toBe(-120);
    expect(hzToNoteName(440)).toBe("A-4");
    expect(hzToNoteName(261.63)).toBe("C-4");
    expect(hzToNoteName(277.18)).toBe("C#4");
    expect(hzToNoteName(0)).toBeNull();
    expect(round(1.234_56, 2)).toBe(1.23);
  });
});
