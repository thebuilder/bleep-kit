import type { Song } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import {
  bufferPositionAt,
  planLoop,
  rampLevel,
  secondsToPosition,
  semitonesToRate,
  startOffset,
} from "../src/schedule.ts";
import { VoiceCap } from "../src/voice-cap.ts";

describe("planLoop: manifest loop points to buffer seconds", () => {
  it("loops the section a song declares", () => {
    expect(planLoop({ loopEnd: 24, loopStart: 4.8 }, 25)).toEqual({
      loop: true,
      loopEnd: 24,
      loopStart: 4.8,
    });
  });

  it("does not loop a song without loop points unless asked", () => {
    expect(planLoop({ loopEnd: null, loopStart: null }, 25)).toEqual({
      loop: false,
      loopEnd: 25,
      loopStart: 0,
    });
    expect(planLoop({ loopEnd: null, loopStart: null }, 25, true)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 0,
    });
  });

  it("lets the caller turn the loop off", () => {
    expect(planLoop({ loopEnd: 24, loopStart: 4.8 }, 25, false).loop).toBe(
      false
    );
  });

  it("clamps points to the decoded buffer and repairs a collapsed section", () => {
    expect(planLoop({ loopEnd: 99, loopStart: 2 }, 25)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 2,
    });
    expect(planLoop({ loopEnd: 3, loopStart: 3 }, 25)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 0,
    });
    expect(planLoop({ loopEnd: 1, loopStart: 5 }, 25)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 0,
    });
    expect(planLoop({ loopEnd: null, loopStart: 4 }, 25)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 4,
    });
    expect(planLoop({ loopEnd: 10, loopStart: -2 }, 25)).toEqual({
      loop: true,
      loopEnd: 10,
      loopStart: 0,
    });
  });

  it("loops from the beginning up to a lone loop end", () => {
    expect(planLoop({ loopEnd: 20, loopStart: null }, 25)).toEqual({
      loop: true,
      loopEnd: 20,
      loopStart: 0,
    });
  });

  it("keeps a short loop section but not one too short for a buffer source to loop", () => {
    expect(planLoop({ loopEnd: 3.02, loopStart: 3 }, 25)).toEqual({
      loop: true,
      loopEnd: 3.02,
      loopStart: 3,
    });
    expect(planLoop({ loopEnd: 3.005, loopStart: 3 }, 25)).toEqual({
      loop: true,
      loopEnd: 25,
      loopStart: 0,
    });
  });
});

describe("bufferPositionAt and startOffset", () => {
  const plan = planLoop({ loopEnd: 24, loopStart: 4.8 }, 25);

  it("plays the intro once and then cycles the loop section", () => {
    expect(bufferPositionAt(0, 0, plan, 25)).toBe(0);
    expect(bufferPositionAt(10, 0, plan, 25)).toBe(10);
    expect(bufferPositionAt(24, 0, plan, 25)).toBeCloseTo(4.8, 9);
    expect(bufferPositionAt(24 + 19.2, 0, plan, 25)).toBeCloseTo(4.8, 9);
    expect(bufferPositionAt(30, 0, plan, 25)).toBeCloseTo(4.8 + 6, 9);
  });

  it("honours a start offset", () => {
    expect(bufferPositionAt(1, 20, plan, 25)).toBe(21);
    expect(bufferPositionAt(5, 20, plan, 25)).toBeCloseTo(4.8 + 1, 9);
  });

  it("ends a non-looping source", () => {
    const once = planLoop({ loopEnd: null, loopStart: null }, 10);
    expect(bufferPositionAt(9.9, 0, once, 10)).toBeCloseTo(9.9, 9);
    expect(bufferPositionAt(10, 0, once, 10)).toBeNull();
    // the offset counts toward the end: starting at 4 s leaves 6 s
    expect(bufferPositionAt(5.9, 4, once, 10)).toBeCloseTo(9.9, 9);
    expect(bufferPositionAt(6, 4, once, 10)).toBeNull();
  });

  it("stays at the start offset for a time before the source began", () => {
    expect(bufferPositionAt(-0.5, 3, plan, 25)).toBe(3);
  });

  it("starts inside the intro or the loop, never beyond the loop end", () => {
    expect(startOffset(undefined, plan, 25)).toBe(0);
    expect(startOffset(12, plan, 25)).toBe(12);
    expect(startOffset(24.5, plan, 25)).toBe(4.8);
    // right at the loop end the source would have wrapped already
    expect(startOffset(24, plan, 25)).toBe(4.8);
    expect(startOffset(23.9, plan, 25)).toBe(23.9);
    expect(startOffset(-3, plan, 25)).toBe(0);
    expect(
      startOffset(99, planLoop({ loopEnd: null, loopStart: null }, 10), 10)
    ).toBe(10);
  });
});

describe("ramps and rates", () => {
  it("interpolates a fade linearly and holds its ends", () => {
    const ramp = { duration: 2, from: 0, start: 10, to: 1 };
    expect(rampLevel(ramp, 9)).toBe(0);
    expect(rampLevel(ramp, 11)).toBe(0.5);
    expect(rampLevel(ramp, 12)).toBe(1);
    expect(rampLevel(ramp, 50)).toBe(1);
    expect(rampLevel({ duration: 0, from: 1, start: 0, to: 0 }, 0)).toBe(0);
  });

  it("converts semitones to a playback rate", () => {
    expect(semitonesToRate(0)).toBe(1);
    expect(semitonesToRate(12)).toBe(2);
    expect(semitonesToRate(-12)).toBe(0.5);
    // four octaves either way is the limit
    expect(semitonesToRate(1000)).toBe(16);
    expect(semitonesToRate(-1000)).toBe(1 / 16);
  });
});

describe("secondsToPosition (startAt in synth mode)", () => {
  const song = {
    loop: 1,
    order: ["a", "b"],
    patterns: { a: { length: 16, tracks: {} }, b: { length: 32, tracks: {} } },
    rowsPerBeat: 4,
    tempo: 120,
  } as unknown as Song;
  // 120 bpm at 4 rows per beat: a row lasts 0.125 s

  it("walks the order list", () => {
    expect(secondsToPosition(song, 0)).toEqual({ order: 0, row: 0 });
    expect(secondsToPosition(song, 1)).toEqual({ order: 0, row: 8 });
    expect(secondsToPosition(song, 2)).toEqual({ order: 1, row: 0 });
    expect(secondsToPosition(song, 2.5)).toEqual({ order: 1, row: 4 });
  });

  it("wraps into the loop section past the end", () => {
    // 48 rows in all (6 s); the loop starts at order 1 (row 16)
    expect(secondsToPosition(song, 6)).toEqual({ order: 1, row: 0 });
    expect(secondsToPosition(song, 6 + 4)).toEqual({ order: 1, row: 0 });
    expect(secondsToPosition(song, 6 + 1)).toEqual({ order: 1, row: 8 });
  });

  it("moves to the next row exactly when a row has passed", () => {
    expect(secondsToPosition(song, 0.124)).toEqual({ order: 0, row: 0 });
    expect(secondsToPosition(song, 0.125)).toEqual({ order: 0, row: 1 });
    expect(secondsToPosition(song, 1.99)).toEqual({ order: 0, row: 15 });
  });

  it("wraps a song without a loop point back to the very start", () => {
    const { loop: _loop, ...noLoop } = song;
    expect(secondsToPosition(noLoop as Song, 6 + 1)).toEqual({
      order: 0,
      row: 8,
    });
  });

  it("copes with a song that has no patterns", () => {
    expect(secondsToPosition({ ...song, order: [] } as Song, 3)).toEqual({
      order: 0,
      row: 0,
    });
  });
});

describe("VoiceCap: polyphony caps", () => {
  it("stops the oldest instance of an id beyond the per-id cap", () => {
    const cap = new VoiceCap<string>({ perId: 2, total: 10 });
    expect(cap.evictFor("coin")).toEqual([]);
    cap.add("coin", "c1");
    expect(cap.evictFor("coin")).toEqual([]);
    cap.add("coin", "c2");
    expect(cap.evictFor("coin")).toEqual(["c1"]);
    cap.add("coin", "c3");
    expect(cap.countOf("coin")).toBe(2);
    expect(cap.evictFor("laser")).toEqual([]);
  });

  it("stops the oldest of the same id, not the oldest voice overall", () => {
    const cap = new VoiceCap<string>({ perId: 2, total: 10 });
    cap.add("b", "b1");
    cap.add("a", "a1");
    cap.add("a", "a2");
    expect(cap.evictFor("a")).toEqual(["a1"]);
    expect(cap.countOf("b")).toBe(1);
  });

  it("stops the oldest voice overall beyond the global cap", () => {
    const cap = new VoiceCap<string>({ perId: 4, total: 3 });
    for (const [id, voice] of [
      ["a", "a1"],
      ["b", "b1"],
      ["c", "c1"],
    ] as const) {
      expect(cap.evictFor(id)).toEqual([]);
      cap.add(id, voice);
    }
    expect(cap.evictFor("d")).toEqual(["a1"]);
    cap.add("d", "d1");
    expect(cap.size).toBe(3);
  });

  it("applies both caps in one go", () => {
    const cap = new VoiceCap<string>({ perId: 1, total: 2 });
    cap.add("x", "x1");
    cap.add("y", "y1");
    // x1 is the id's oldest, then the global cap is satisfied already
    expect(cap.evictFor("x")).toEqual(["x1"]);
    expect(cap.size).toBe(1);
  });

  it("forgets finished voices and clears on request", () => {
    const cap = new VoiceCap<string>({ perId: 2, total: 2 });
    cap.add("a", "a1");
    cap.add("a", "a2");
    cap.remove("a1");
    expect(cap.evictFor("a")).toEqual([]);
    expect(cap.clear()).toEqual(["a2"]);
    expect(cap.size).toBe(0);
  });

  it("never lets a cap fall below one", () => {
    const cap = new VoiceCap<string>({ perId: 0, total: 0 });
    cap.add("a", "a1");
    expect(cap.evictFor("a")).toEqual(["a1"]);
  });
});
