/* User samples (architecture.md section 2.10): the base64 helpers, normalize, import preparation, pitch detection and
   how the engine plays them on the Amiga (period steps, 8 bit data, hard panning). */

import { describe, expect, it } from "vitest";
import type { Instrument, UserSample } from "../src/index.ts";
import {
  base64ToBytes,
  bytesToBase64,
  defaultInstrument,
  defaultSong,
  isBase64,
  normalizeInstrument,
  normalizeSample,
  normalizeSong,
  prepareImport,
  renderInstrumentNote,
  renderSong,
  sampleFromData,
} from "../src/index.ts";
import { detectSamplePitch } from "../src/tools.ts";
import { peak, zeroCrossingHz } from "./helpers.ts";

function sine(hz: number, rate: number, seconds: number): Float32Array {
  const n = Math.round(rate * seconds);
  return Float32Array.from(
    { length: n },
    (_, i) => 0.8 * Math.sin((2 * Math.PI * hz * i) / rate)
  );
}

function sampleInstrument(id: string): Instrument {
  const inst = defaultInstrument("sample", "amiga");
  inst.sample = {
    baseNote: 60,
    generator: "pluck",
    loop: false,
    params: {},
    seed: 1,
    userSample: id,
  };
  inst.envelope = { attack: 0, decay: 0, release: 0.01, sustain: 1 };
  return inst;
}

describe("base64 helpers", () => {
  it("round trips every byte value and checks the shape", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = bytesToBase64(bytes);
    expect(isBase64(text)).toBe(true);
    expect(Array.from(base64ToBytes(text))).toEqual(Array.from(bytes));
    expect(isBase64("abc")).toBe(false);
    expect(isBase64("ab=c")).toBe(false);
  });
});

describe("normalizeSample", () => {
  const good = (): Record<string, unknown> => ({
    ...sampleFromData(sine(440, 8000, 0.1), 8000),
  });

  it("accepts a sample and defaults the optional fields", () => {
    const { value, issues } = normalizeSample(good());
    expect(issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(value).toMatchObject({
      baseNote: 60,
      bits: 16,
      finetune: 0,
      loop: null,
      rate: 8000,
      volume: 1,
    });
  });

  it("rejects bad base64, a half frame and too much audio, with the limit in the message", () => {
    expect(
      normalizeSample({ ...good(), data: "not base64!" }).issues[0]?.message
    ).toContain("not valid base64");
    expect(
      normalizeSample({ ...good(), data: bytesToBase64(new Uint8Array(3)) })
        .issues[0]?.message
    ).toContain("16 bit");
    const big = bytesToBase64(new Uint8Array(2 * 1024 * 1024 + 3));
    const r = normalizeSample({ ...good(), bits: 8, data: big });
    expect(
      r.issues.some(
        (i) => i.severity === "error" && i.message.includes("2.00 MiB")
      )
    ).toBe(true);
  });

  it("removes a loop shorter than two frames with a warning", () => {
    const r = normalizeSample({ ...good(), loop: { end: 11, start: 10 } });
    expect(r.value.loop).toBeNull();
    expect(r.issues.some((i) => i.severity === "warning")).toBe(true);
  });
});

describe("prepareImport", () => {
  it("mixes to mono, resamples to the chip's rate and stores 8 bit for the Amiga", () => {
    const left = sine(440, 44_100, 0.2);
    const right = sine(440, 44_100, 0.2);
    const out = prepareImport([left, right], 44_100, "amiga", { name: "tone" });
    expect(out.sample.bits).toBe(8);
    expect(out.sample.rate).toBe(16_574);
    expect(out.sample.name).toBe("tone");
    expect(out.notes.join(" ")).toContain("mixed 2 channels to mono");
    expect(out.notes.join(" ")).toContain("resampled");
    expect(base64ToBytes(out.sample.data).length).toBe(
      Math.round(0.2 * 16_574)
    );
    const snes = prepareImport([left], 44_100, "snes");
    expect(snes.sample.bits).toBe(16);
    expect(snes.sample.rate).toBe(32_000);
  });

  it("cuts audio longer than 2 MiB and says so", () => {
    const out = prepareImport([new Float32Array(2_200_000)], 16_574, "amiga");
    expect(base64ToBytes(out.sample.data).length).toBe(2 * 1024 * 1024);
    expect(out.notes.join(" ")).toContain("cut to the first");
  });
});

describe("detectSamplePitch", () => {
  it("finds the note of a tone", () => {
    const p = detectSamplePitch(sine(220, 16_000, 0.5), 16_000);
    expect(p?.note).toBe(57);
    expect(Math.abs(p?.cents ?? 99)).toBeLessThan(10);
  });

  it("gives up on silence", () => {
    expect(detectSamplePitch(new Float32Array(8000), 8000)).toBeNull();
  });
});

describe("user samples on the Amiga", () => {
  const samples: Record<string, UserSample> = {
    tone: sampleFromData(sine(1000, 16_574, 0.3), 16_574, {
      baseNote: 60,
      bits: 8,
      name: "tone",
    }),
  };

  it("plays a sample at its own pitch on the base note, in period steps", () => {
    const inst = sampleInstrument("tone");
    const r = renderInstrumentNote(inst, 60, {
      chip: "amiga",
      duration: 0.2,
      sampleRate: 22_050,
      samples,
    });
    const hz = zeroCrossingHz(r.channels[0] ?? new Float32Array(0), 22_050);
    // The sample holds a 1000 Hz sine at 16574 Hz; at the base note it plays unchanged, to within one period step.
    expect(Math.abs(hz - 1000)).toBeLessThan(25);
    const up = renderInstrumentNote(inst, 72, {
      chip: "amiga",
      duration: 0.2,
      sampleRate: 22_050,
      samples,
    });
    expect(
      Math.abs(
        zeroCrossingHz(up.channels[0] ?? new Float32Array(0), 22_050) - 2000
      )
    ).toBeLessThan(60);
  });

  it("keeps channels 1 and 4 left, 2 and 3 right", () => {
    const inst = sampleInstrument("tone");
    const { value: song } = normalizeSong(
      {
        ...defaultSong("amiga"),
        channels: ["ch1", "ch2"].map((id) => ({
          id,
          instrument: "tone",
          kind: "sample",
          mml: null,
          muted: false,
          pan: 0,
          volume: 1,
        })),
        loop: null,
        order: ["a"],
        patterns: {
          a: {
            length: 4,
            tracks: {
              ch1: [{ fx: [], inst: null, note: 60, row: 0, vol: null }],
            },
          },
        },
      },
      { tone: inst }
    );
    const r = renderSong(song, { tone: inst }, { sampleRate: 22_050, samples });
    expect(peak([r.channels[0] ?? new Float32Array(0)])).toBeGreaterThan(0.01);
    expect(peak([r.channels[1] ?? new Float32Array(0)])).toBe(0);
  });

  it("warns when an instrument names a sample the project does not have", () => {
    const r = normalizeInstrument(sampleInstrument("missing"), {});
    expect(
      r.issues.some(
        (i) =>
          i.path === "/sample/userSample" &&
          i.message.includes("does not exist")
      )
    ).toBe(true);
    expect(
      normalizeInstrument(sampleInstrument("tone"), { tone: {} }).issues
    ).toEqual([]);
  });
});
