import { describe, expect, it } from "vitest";
import {
  createRingReader,
  MAX_SCOPE_CHANNELS,
  PostedRings,
  sharedRingSource,
  sharedScopeBytes,
} from "../src/scope.ts";

const ramp = (from: number, n: number) =>
  Float32Array.from({ length: n }, (_, i) => from + i);

describe("shared scope layout", () => {
  it("has room for the head, ten channels and two master rings", () => {
    expect(sharedScopeBytes(2048)).toBe(4 + 4 * 2048 * 12);
    expect(sharedScopeBytes(256, 4)).toBe(4 + 4 * 256 * 6);
  });

  it("reads rings the synth writes, in the documented order", () => {
    const frames = 64;
    const buffer = new SharedArrayBuffer(sharedScopeBytes(frames));
    const head = new Uint32Array(buffer, 0, 1);
    const view = (index: number) =>
      new Float32Array(buffer, 4 + 4 * frames * index, frames);
    // channel 3 holds frame numbers, master L holds negative frame numbers
    for (let f = 0; f < 100; f += 1) {
      view(3)[f % frames] = f;
      view(MAX_SCOPE_CHANNELS)[f % frames] = -f;
      view(MAX_SCOPE_CHANNELS + 1)[f % frames] = f * 2;
    }
    head[0] = 100 % frames;
    const reader = createRingReader(sharedRingSource(buffer, frames));
    expect(Array.from(reader.latest(3, 4))).toEqual([96, 97, 98, 99]);
    expect(Array.from(reader.latest(-1, 3))).toEqual([-97, -98, -99]);
    expect(Array.from(reader.latest(-2, 2))).toEqual([196, 198]);
    // an absolute frame inside the last 64
    expect(Array.from(reader.at(3, 80, 5))).toEqual([80, 81, 82, 83, 84]);
    // wraps across the end of the ring: indices 62, 63, 0, 1 hold frames 62, 63, 64, 65
    expect(Array.from(reader.at(3, 62 + 64, 4))).toEqual([62, 63, 64, 65]);
  });

  it("answers zeros for channels the layout does not have", () => {
    const frames = 16;
    const buffer = new SharedArrayBuffer(sharedScopeBytes(frames));
    const reader = createRingReader(sharedRingSource(buffer, frames));
    expect(Array.from(reader.latest(10, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(reader.latest(-3, 4))).toEqual([0, 0, 0, 0]);
  });
});

describe("posted scope copies", () => {
  it("land at their absolute frame so latest and at line up", () => {
    const rings = new PostedRings(2048);
    rings.write(1024, [ramp(0, 1024)], [ramp(0, 1024), ramp(5000, 1024)]);
    rings.write(2048, [ramp(1024, 1024)], [ramp(1024, 1024), ramp(6024, 1024)]);
    const reader = createRingReader(rings);
    expect(Array.from(reader.latest(0, 3))).toEqual([2045, 2046, 2047]);
    expect(Array.from(reader.at(0, 1000, 2))).toEqual([1000, 1001]);
    expect(Array.from(reader.latest(-2, 2))).toEqual([7046, 7047]);
    rings.write(3072, [ramp(2048, 1024)], [ramp(2048, 1024), ramp(7048, 1024)]);
    // the ring wrapped: frames 2048..3071 now overwrite 0..1023
    expect(Array.from(reader.latest(0, 2))).toEqual([3070, 3071]);
    expect(Array.from(reader.at(0, 2048 + 10, 2))).toEqual([2058, 2059]);
    expect(Array.from(reader.at(0, 1100, 2))).toEqual([1100, 1101]);
  });

  it("allocates channel rings as copies arrive and reads silence from the rest", () => {
    const rings = new PostedRings(256);
    const reader = createRingReader(rings);
    expect(Array.from(reader.latest(2, 3))).toEqual([0, 0, 0]);
    rings.write(100, [ramp(1, 100), ramp(1, 100), ramp(1, 100)], []);
    expect(reader.latest(2, 1)[0]).toBe(100);
    expect(rings.ring(7)).toBeNull();
  });

  it("keeps only the newest samples of a copy larger than the ring", () => {
    const rings = new PostedRings(8);
    rings.write(20, [ramp(0, 20)], []);
    expect(Array.from(createRingReader(rings).latest(0, 8))).toEqual([
      12, 13, 14, 15, 16, 17, 18, 19,
    ]);
  });
});

describe("the reader", () => {
  it("hands out one buffer per channel, reused between calls, and clamps the size", () => {
    const rings = new PostedRings(32);
    rings.write(32, [ramp(0, 32), ramp(100, 32)], []);
    const reader = createRingReader(rings);
    const a = reader.latest(0, 8);
    const b = reader.latest(1, 8);
    expect(a).not.toBe(b);
    expect(reader.latest(0, 8)).toBe(a);
    expect(reader.latest(0, 1000)).toHaveLength(32);
    expect(reader.latest(0, 0)).toHaveLength(1);
    expect(a[0]).toBe(24);
    expect(b[0]).toBe(124);
  });
});
