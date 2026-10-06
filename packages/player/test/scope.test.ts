import {
  createSynth,
  type EngineEvent,
  normalizeSfx,
  SCOPE_FRAMES,
} from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import coinJson from "../../core/test/fixtures/sfx-coin.json" with {
  type: "json",
};
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
  // section 5.3: a 4 byte head, then ten channel rings and two master rings of `frames` float32 each
  it("has room for the head, ten channels and two master rings", () => {
    expect(sharedScopeBytes(2048)).toBe(98_308);
    expect(sharedScopeBytes(256, 4)).toBe(6148);
    expect(sharedScopeBytes(SCOPE_FRAMES)).toBe(4 + 4 * 8192 * 12);
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
    // the newest 40 frames start before the head's position in the ring, so the window wraps backwards
    expect(Array.from(reader.latest(3, 40))).toEqual(
      Array.from({ length: 40 }, (_, i) => 60 + i)
    );
    // an absolute frame inside the last 64
    expect(Array.from(reader.at(3, 80, 5))).toEqual([80, 81, 82, 83, 84]);
    // wraps across the end of the ring: indices 62, 63, 0, 1 hold frames 62, 63, 64, 65
    expect(Array.from(reader.at(3, 62 + 64, 4))).toEqual([62, 63, 64, 65]);
  });

  it("answers zeros for channels the layout does not have, even when every ring holds sound", () => {
    const frames = 16;
    const buffer = new SharedArrayBuffer(sharedScopeBytes(frames));
    // fill every ring (channels and both masters) so that reading the wrong ring cannot pass for silence
    new Float32Array(buffer, 4).fill(7);
    const reader = createRingReader(sharedRingSource(buffer, frames));
    expect(Array.from(reader.latest(10, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(reader.latest(-3, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(reader.latest(9, 2))).toEqual([7, 7]);
    expect(Array.from(reader.latest(-2, 2))).toEqual([7, 7]);
  });

  it("puts the master rings right after however many channels the layout was given", () => {
    const frames = 8;
    const channels = 4;
    const buffer = new SharedArrayBuffer(sharedScopeBytes(frames, channels));
    const rings = new Float32Array(buffer, 4);
    // ring index i holds the value i + 1: channels 0..3, then master left (5), master right (6)
    for (let ring = 0; ring < channels + 2; ring += 1) {
      rings.fill(ring + 1, ring * frames, (ring + 1) * frames);
    }
    const reader = createRingReader(sharedRingSource(buffer, frames, channels));
    expect(reader.latest(3, 1)[0]).toBe(4);
    expect(reader.latest(-1, 1)[0]).toBe(5);
    expect(reader.latest(-2, 1)[0]).toBe(6);
    // channel 4 is not in this layout, and must not read the master ring that sits where it would be
    expect(reader.latest(4, 1)[0]).toBe(0);
  });

  // The writer is the engine in @bleepkit/core, the reader is this package: only a real render shows they agree.
  it("reads exactly the samples the real synth just rendered, across the ring's wrap", () => {
    const frames = 512;
    const buffer = new SharedArrayBuffer(sharedScopeBytes(frames));
    const synth = createSynth({
      sampleRate: 48_000,
      scopeBuffer: buffer,
      scopeFrames: frames,
    });
    synth.loadSfx("coin", normalizeSfx(coinJson).value);
    synth.trigger("coin");
    // 7 blocks of 128: 896 frames, so the 512 frame ring has wrapped once
    const left = new Float32Array(896);
    const right = new Float32Array(896);
    const events: EngineEvent[] = [];
    for (let at = 0; at < 896; at += 128) {
      synth.process(
        left.subarray(at, at + 128),
        right.subarray(at, at + 128),
        128,
        events
      );
    }
    expect(left.some((v) => Math.abs(v) > 0.05)).toBe(true);
    const reader = createRingReader(sharedRingSource(buffer, frames));
    expect(Array.from(reader.latest(-1, 256))).toEqual(
      Array.from(left.subarray(640, 896))
    );
    expect(Array.from(reader.latest(-2, 256))).toEqual(
      Array.from(right.subarray(640, 896))
    );
    // `at` takes the start of the window, in absolute engine frames
    expect(Array.from(reader.at(-1, 700, 100))).toEqual(
      Array.from(left.subarray(700, 800))
    );
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

  it("keep a low note whole in the scope ring and never read frames that have not arrived", () => {
    // the default ring is sized so two periods of the lowest bass (27 Hz, 1780 frames at 48 kHz) fit with margin
    expect(SCOPE_FRAMES).toBeGreaterThanOrEqual(4 * 1780);
    const rate = 48_000;
    const hz = 27.5;
    const saw = (from: number, n: number) =>
      Float32Array.from(
        { length: n },
        (_, i) => (((from + i) * hz) / rate) % 1
      );
    const rings = new PostedRings(SCOPE_FRAMES);
    // the worklet posts the newest 1024 frames every 1024 frames: 5 posts, 5120 frames
    for (let f = 1024; f <= 5 * 1024; f += 1024) {
      rings.write(f, [saw(f - 1024, 1024)], [saw(f - 1024, 1024)]);
    }
    const reader = createRingReader(rings);
    // 4096 frames, more than two periods of 27.5 Hz, straight out of the posted copies
    expect(Array.from(reader.at(0, 1024, 4096))).toEqual(
      Array.from(saw(1024, 4096))
    );
    // the engine is already past the last post (the clock runs ahead of the copies): the window moves back, so the
    // frames after the last copy (a whole ring old, in the ring) are not read
    expect(Array.from(reader.at(0, 2000, 4096))).toEqual(
      Array.from(saw(5120 - 4096, 4096))
    );
    expect(Array.from(reader.at(0, 1024, 4096))).toEqual(
      Array.from(reader.at(0, 4000, 4096))
    );
    expect(rings.end()).toBe(5120);
  });

  it("allocates channel rings as copies arrive and reads silence from the rest", () => {
    const rings = new PostedRings(256);
    const reader = createRingReader(rings);
    expect(Array.from(reader.latest(2, 3))).toEqual([0, 0, 0]);
    rings.write(100, [ramp(1, 100), ramp(1, 100), ramp(1, 100)], []);
    expect(reader.latest(2, 1)[0]).toBe(100);
    expect(rings.ring(7)).toBeNull();
  });

  it("wraps a copy that starts before frame zero to the end of the ring", () => {
    const rings = new PostedRings(256);
    // 10 samples ending at frame 5: the first five belong to frames -5..-1
    rings.write(5, [ramp(0, 10)], []);
    const reader = createRingReader(rings);
    expect(Array.from(reader.latest(0, 5))).toEqual([5, 6, 7, 8, 9]);
    expect(Array.from(reader.at(0, -5, 5))).toEqual([0, 1, 2, 3, 4]);
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
