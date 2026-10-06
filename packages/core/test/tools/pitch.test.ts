import { describe, expect, it } from "vitest";
import { trackPitch } from "../../src/tools/pitch.ts";
import { dbToAmp, noise, pulse, sine } from "./helpers.ts";

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function pitched(track: ReturnType<typeof trackPitch>): number[] {
  return track.flatMap((p) => (p.hz === null ? [] : [p.hz]));
}

/** A sine whose RMS (not peak) level is this many dBFS. */
const sineAtRms = (db: number) =>
  sine(48_000, 0.3, 440, dbToAmp(db) * Math.SQRT2);

describe("trackPitch", () => {
  // 55 Hz is the NES triangle's A1: the lowest notes a game bass line plays
  it.each([55, 110, 220, 440, 880, 1760, 3520])(
    "finds a %i Hz sine within 1 Hz",
    (hz) => {
      const track = trackPitch(sine(48_000, 0.5, hz, 0.5), 48_000);
      const found = pitched(track);
      expect(found.length).toBeGreaterThan(track.length * 0.9);
      expect(Math.abs(median(found) - hz)).toBeLessThan(1);
    }
  );

  it("works at 44.1 kHz", () => {
    const found = pitched(trackPitch(sine(44_100, 0.4, 440, 0.5), 44_100));
    expect(Math.abs(median(found) - 440)).toBeLessThan(1);
  });

  it.each([0.125, 0.25, 0.5, 0.75])(
    "tracks a pulse wave at duty %f",
    (duty) => {
      const found = pitched(
        trackPitch(pulse(48_000, 0.4, 330, 0.4, duty), 48_000)
      );
      expect(Math.abs(median(found) - 330)).toBeLessThan(2);
    }
  );

  it("follows a pitch change", () => {
    const a = sine(48_000, 0.3, 300, 0.5);
    const b = sine(48_000, 0.3, 600, 0.5);
    const both = new Float32Array(a.length + b.length);
    both.set(a);
    both.set(b, a.length);
    const track = trackPitch(both, 48_000);
    const early = track
      .filter((p) => p.time < 0.2)
      .flatMap((p) => (p.hz === null ? [] : [p.hz]));
    const late = track
      .filter((p) => p.time > 0.4)
      .flatMap((p) => (p.hz === null ? [] : [p.hz]));
    expect(Math.abs(median(early) - 300)).toBeLessThan(2);
    expect(Math.abs(median(late) - 600)).toBeLessThan(3);
  });

  it("reports silence and noise as unpitched", () => {
    const silent = trackPitch(new Float32Array(20_000), 48_000);
    expect(silent.every((p) => p.hz === null && p.confidence === 0)).toBe(true);
    const hiss = trackPitch(noise(48_000, 0.4, 0.5), 48_000);
    expect(hiss.filter((p) => p.hz !== null).length).toBeLessThan(
      hiss.length * 0.1
    );
  });

  it("treats frames under -60 dBFS RMS as silence and anything above as a tone", () => {
    const quiet = trackPitch(sineAtRms(-61), 48_000);
    expect(quiet.every((p) => p.hz === null && p.confidence === 0)).toBe(true);
    const faint = pitched(trackPitch(sineAtRms(-59), 48_000));
    expect(faint.length).toBeGreaterThan(0);
    expect(Math.abs(median(faint) - 440)).toBeLessThan(1);
  });

  it("has high confidence on a clean tone", () => {
    const track = trackPitch(sine(48_000, 0.3, 440, 0.5), 48_000);
    expect(median(track.map((p) => p.confidence))).toBeGreaterThan(0.95);
  });

  it("times frames by their middle and honors window and hop", () => {
    const track = trackPitch(sine(48_000, 0.5, 440, 0.5), 48_000, {
      hop: 1024,
      window: 2048,
    });
    expect(track[0]?.time).toBeCloseTo(1024 / 48_000, 9);
    expect((track[1]?.time ?? 0) - (track[0]?.time ?? 0)).toBeCloseTo(
      1024 / 48_000,
      9
    );
  });

  it("only reports pitches between minHz and maxHz", () => {
    const tone = sine(48_000, 0.4, 440, 0.5);
    // the control: with a range that holds 440 Hz it is found
    const inside = pitched(
      trackPitch(tone, 48_000, { maxHz: 1000, minHz: 100 })
    );
    expect(Math.abs(median(inside) - 440)).toBeLessThan(1);
    // a ceiling below 440 Hz cannot report it: nothing above the ceiling comes out
    const below = pitched(trackPitch(tone, 48_000, { maxHz: 300 }));
    expect(below.every((hz) => hz <= 300)).toBe(true);
    // a floor above 440 Hz cannot report it either
    const above = pitched(trackPitch(tone, 48_000, { minHz: 600 }));
    expect(above.every((hz) => hz >= 600)).toBe(true);
  });

  it("still gives one frame for a signal shorter than the window", () => {
    expect(trackPitch(sine(48_000, 0.02, 440, 0.5), 48_000)).toHaveLength(1);
  });
});
