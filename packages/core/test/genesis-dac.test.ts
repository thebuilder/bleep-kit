/* The YM2612 DAC (architecture.md section 3.12): "FM6 plays samples (DAC)". The setting, how normalize treats fm6, and
   how the engine plays a sample on it: 8 bit, mono, 8 to 26 kHz in whole Z80 cycles, one sample at a time, no FM. */

import { describe, expect, it } from "vitest";
import type { Instrument, Song, UserSample } from "../src/index.ts";
import {
  chipChannels,
  defaultInstrument,
  hardwareChannels,
  makeInstrument,
  normalizeSong,
  quantizeDacRate,
  renderInstrumentNote,
  renderSong,
  sampleFromData,
} from "../src/index.ts";
import { peak, rms } from "./helpers.ts";

const SR = 48_000;

/** A deterministic noise-like burst (a fixed linear congruential sequence), so the length of the sound is easy to see. */
function burst(frames: number): Float32Array {
  let x = 12_345;
  return Float32Array.from({ length: frames }, () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (x / 2_147_483_648) * 0.8 - 0.4;
  });
}

function dacInstrument(sample: string): Instrument {
  const inst = defaultInstrument("sample", "genesis");
  inst.sample = {
    baseNote: 60,
    generator: "kick909",
    loop: false,
    params: {},
    seed: 1,
    userSample: sample,
  };
  inst.envelope = { attack: 0, decay: 0, release: 0.01, sustain: 1 };
  return inst;
}

function dacSong(rows: Record<number, string>, length = 16): Song {
  const out = normalizeSong(
    {
      channels: [{ id: "fm6", instrument: "hit" }],
      chip: "genesis",
      loop: null,
      master: { genesis: { dac: true }, volume: 0.8 },
      order: ["a"],
      patterns: {
        a: {
          length,
          tracks: {
            fm6: Object.entries(rows).map(([row, s]) => ({
              row: Number(row),
              s,
            })),
          },
        },
      },
      rowsPerBeat: 4,
      tempo: 120,
    },
    undefined
  );
  expect(out.issues.filter((i) => i.severity === "error")).toEqual([]);
  return out.value;
}

/** The last frame of a render whose level is above the threshold, in seconds. */
function lastAudible(left: Float32Array, threshold = 0.004): number {
  for (let i = left.length - 1; i >= 0; i -= 1) {
    if (Math.abs(left[i] ?? 0) > threshold) {
      return i / SR;
    }
  }
  return 0;
}

function render(
  song: Song,
  sample: UserSample,
  tail = 0.2
): { left: Float32Array; right: Float32Array } {
  const r = renderSong(song, { hit: dacInstrument("s") }, {
    master: { limiter: false, volume: 1 },
    samples: { s: sample },
    sampleRate: SR,
    tail,
  });
  return { left: r.channels[0] as Float32Array, right: r.channels[1] as Float32Array };
}

describe("the DAC setting", () => {
  it("fm6 is an FM channel until the DAC is on, then a sample channel; the other channels do not change", () => {
    const off = hardwareChannels("genesis");
    const on = hardwareChannels("genesis", { genesis: { dac: true } });
    expect(off.find((c) => c.id === "fm6")?.kind).toBe("fm");
    expect(on.find((c) => c.id === "fm6")).toMatchObject({
      id: "fm6",
      kind: "sample",
    });
    expect(on.map((c) => c.id)).toEqual(off.map((c) => c.id));
    expect(on.filter((c) => c.kind === "fm")).toHaveLength(5);
    // only a genesis song has it
    expect(
      hardwareChannels("nes", { genesis: { dac: true } }).map((c) => c.kind)
    ).toEqual(hardwareChannels("nes").map((c) => c.kind));
    expect(
      chipChannels({ channels: [], chip: "genesis", master: { genesis: { dac: true } } })[5]
        ?.kind
    ).toBe("sample");
  });

  it("normalize keeps it only when it is on, and makes fm6 a sample channel", () => {
    const on = normalizeSong({
      chip: "genesis",
      master: { genesis: { dac: true } },
    });
    expect(on.value.master.genesis).toEqual({ dac: true });
    expect(on.value.channels.find((c) => c.id === "fm6")?.kind).toBe("sample");
    const off = normalizeSong({
      chip: "genesis",
      master: { genesis: { dac: false } },
    });
    expect(off.value.master.genesis).toBeUndefined();
    expect(off.value.channels.find((c) => c.id === "fm6")?.kind).toBe("fm");
    // a song without the setting normalizes exactly as it did before the DAC existed
    expect(Object.keys(normalizeSong({ chip: "genesis" }).value.master)).toEqual([
      "volume",
      "echo",
      "reverb",
    ]);
    const nes = normalizeSong({ chip: "nes", master: { genesis: { dac: true } } });
    expect(nes.value.master.genesis).toBeUndefined();
    expect(nes.issues.map((i) => i.path)).toContain("/master/genesis");
    const bad = normalizeSong({ chip: "genesis", master: { genesis: { dac: 1 } } });
    expect(bad.ok).toBe(false);
    expect(bad.issues.find((i) => i.path === "/master/genesis/dac")).toBeDefined();
    // idempotent
    const again = normalizeSong(on.value);
    expect(again.issues).toEqual([]);
    expect(again.value).toEqual(on.value);
  });

  it("an FM instrument does not play on fm6 in DAC mode, and a sample does not play there without it", () => {
    const fm = makeInstrument("fm", "genesis", "lead", "Lead");
    const sample = makeInstrument("sample", "genesis", "drums", "Kick");
    const song = (dac: boolean, instrument: string) => ({
      channels: [{ id: "fm6", instrument }],
      chip: "genesis",
      master: dac ? { genesis: { dac: true } } : {},
    });
    const withDac = normalizeSong(song(true, "lead"), { lead: fm, kick: sample });
    expect(withDac.ok).toBe(false);
    expect(withDac.issues.find((i) => i.severity === "error")?.message).toContain(
      "DAC"
    );
    expect(normalizeSong(song(true, "kick"), { lead: fm, kick: sample }).ok).toBe(
      true
    );
    const without = normalizeSong(song(false, "kick"), { lead: fm, kick: sample });
    expect(without.ok).toBe(false);
    expect(without.issues.find((i) => i.severity === "error")?.message).toContain(
      "DAC mode"
    );
    expect(normalizeSong(song(false, "lead"), { lead: fm, kick: sample }).ok).toBe(
      true
    );
  });

  it("warns when a note would need a rate outside 8 to 26 kHz", () => {
    const sample = makeInstrument("sample", "genesis", "drums", "Kick");
    const song = (note: string) =>
      normalizeSong(
        {
          channels: [{ id: "fm6", instrument: "kick" }],
          chip: "genesis",
          master: { genesis: { dac: true } },
          order: ["a"],
          patterns: { a: { length: 4, tracks: { fm6: [{ row: 0, s: note }] } } },
        },
        { kick: sample }
      );
    expect(song("C-4").issues.filter((i) => i.path.startsWith("/patterns"))).toEqual(
      []
    );
    // an octave up is still inside (the generated rate is 12969 Hz), two octaves are not, nor is a fourth below -8
    expect(song("C-5").issues.filter((i) => i.path.startsWith("/patterns"))).toEqual(
      []
    );
    const high = song("C-6").issues.find((i) => i.path.startsWith("/patterns"));
    expect(high?.severity).toBe("warning");
    expect(high?.message).toContain("DAC");
    const low = song("C-2").issues.find((i) => i.path.startsWith("/patterns"));
    expect(low?.severity).toBe("warning");
  });
});

describe("the DAC rate", () => {
  it("is held inside 8 to 26 kHz and is the Z80 clock over a whole number of cycles", () => {
    expect(quantizeDacRate(1000)).toBeCloseTo(3_579_545 / Math.round(3_579_545 / 8000), 6);
    expect(quantizeDacRate(100_000)).toBeCloseTo(3_579_545 / Math.round(3_579_545 / 26_000), 6);
    for (const want of [8000, 11_025, 13_000, 22_050, 26_000]) {
      const got = quantizeDacRate(want);
      expect(got).toBeGreaterThanOrEqual(7999);
      expect(got).toBeLessThanOrEqual(26_001);
      expect(Math.abs(got / want - 1)).toBeLessThan(0.005);
      expect(Number.isInteger(3_579_545 / got + 1e-9) || Math.abs(3_579_545 / got - Math.round(3_579_545 / got)) < 1e-9).toBe(true);
    }
  });

  it("sets how long a sample plays: unity at its own rate, the limits at 8 and 26 kHz", () => {
    // 1 s at 8000 Hz: noise, base note C-4
    const sample = sampleFromData(burst(8000), 8000, { bits: 8 });
    const dur = (note: string) => lastAudible(render(dacSong({ 0: note }), sample).left);
    expect(dur("C-4")).toBeGreaterThan(0.97);
    expect(dur("C-4")).toBeLessThan(1.03);
    // an octave up doubles the rate: half the length
    expect(dur("C-5")).toBeGreaterThan(0.47);
    expect(dur("C-5")).toBeLessThan(0.53);
    // an octave down would need 4 kHz: the driver holds 8 kHz, so the length does not change
    expect(dur("C-3")).toBeGreaterThan(0.97);
    expect(dur("C-3")).toBeLessThan(1.03);
    // two octaves up would be 32 kHz: held at 26 kHz, 8000 / 26000 s
    expect(dur("C-6")).toBeGreaterThan(0.29);
    expect(dur("C-6")).toBeLessThan(0.33);
  });
});

describe("playing on the DAC", () => {
  it("plays 8 bit data: a recording quieter than one 8 bit step is silence, a louder one is not", () => {
    const quiet = Float32Array.from(
      { length: 4000 },
      (_, i) => 0.003 * Math.sin((2 * Math.PI * 200 * i) / 8000)
    );
    const loud = quiet.map((v) => v * 60);
    expect(
      peak([render(dacSong({ 0: "C-4" }), sampleFromData(quiet, 8000)).left])
    ).toBe(0);
    const { left, right } = render(
      dacSong({ 0: "C-4" }),
      sampleFromData(loud, 8000)
    );
    expect(peak([left])).toBeGreaterThan(0.01);
    // mono: the DAC feeds the centre of the stereo output
    for (let i = 0; i < left.length; i += 97) {
      expect(left[i]).toBeCloseTo(right[i] ?? 0, 6);
    }
  });

  it("a new note cuts the one before it: one sample at a time", () => {
    const sample = sampleFromData(burst(16_000), 8000, { bits: 8 });
    // two hits a quarter note apart (0.5 s at 120 bpm) of a 2 s sample
    const twice = render(dacSong({ 0: "C-4", 4: "C-4" }, 32), sample, 0.1).left;
    const once = render(dacSong({ 4: "C-4" }, 32), sample, 0.1).left;
    const start = Math.round(0.5 * SR);
    // after a few ms the second hit sounds exactly as it does on its own: nothing of the first is mixed in
    const from = start + Math.round(0.03 * SR);
    const to = start + Math.round(0.5 * SR);
    let worst = 0;
    for (let i = from; i < to; i += 1) {
      worst = Math.max(worst, Math.abs((twice[i] ?? 0) - (once[i] ?? 0)));
    }
    expect(worst).toBeLessThan(1e-5);
    // and the sample really is longer than the gap, so something was cut
    expect(lastAudible(render(dacSong({ 0: "C-4" }, 32), sample, 0.1).left)).toBeGreaterThan(1.9);
  });

  it("a note off stops the sample, and the instrument's envelope does not shape it", () => {
    const sample = sampleFromData(burst(16_000), 8000, { bits: 8 });
    const stopped = render(dacSong({ 0: "C-4", 4: "OFF" }, 32), sample, 0.1).left;
    expect(lastAudible(stopped)).toBeLessThan(0.56);
    expect(lastAudible(stopped)).toBeGreaterThan(0.48);
    // flat level while it plays: the RMS of the first and the last quarter second match
    const whole = render(dacSong({ 0: "C-4" }, 32), sample, 0.1).left;
    const a = rms(whole, 4800, 16_800);
    const b = rms(whole, 72_000, 84_000);
    expect(Math.abs(20 * Math.log10(a / b))).toBeLessThan(1.5);
  });

  it("the other FM channels keep playing FM while fm6 plays samples", () => {
    const bass = makeInstrument("fm", "genesis", "bass", "Bass");
    const song = normalizeSong(
      {
        channels: [
          { id: "fm1", instrument: "bass" },
          { id: "fm6", instrument: "hit" },
        ],
        chip: "genesis",
        loop: null,
        master: { genesis: { dac: true } },
        order: ["a"],
        patterns: {
          a: {
            length: 8,
            tracks: {
              fm1: [{ row: 0, s: "C-2" }],
              fm6: [{ row: 0, s: "C-4" }],
            },
          },
        },
      },
      { bass, hit: dacInstrument("s") }
    );
    expect(song.ok).toBe(true);
    const r = renderSong(
      song.value,
      { bass, hit: dacInstrument("s") },
      {
        samples: { s: sampleFromData(burst(2000), 8000, { bits: 8 }) },
        sampleRate: SR,
        stems: true,
        tail: 0.3,
      }
    );
    const ids = r.stemIds ?? [];
    const fm1 = r.stems?.[ids.indexOf("fm1")] as Float32Array;
    const fm6 = r.stems?.[ids.indexOf("fm6")] as Float32Array;
    expect(peak([fm1])).toBeGreaterThan(0.05);
    expect(peak([fm6])).toBeGreaterThan(0.05);
    // the DAC stream is the 0.25 s of noise, the bass rings on after it
    expect(lastAudible(fm6, 0.003)).toBeLessThan(0.3);
    expect(lastAudible(fm1, 0.003)).toBeGreaterThan(0.4);
  });

  it("a sample instrument previews on the genesis through the DAC", () => {
    const inst = dacInstrument("s");
    const r = renderInstrumentNote(inst, 60, {
      chip: "genesis",
      duration: 0.3,
      release: 0.1,
      samples: { s: sampleFromData(burst(4000), 8000, { bits: 8 }) },
      sampleRate: SR,
    });
    expect(peak(r.channels)).toBeGreaterThan(0.01);
  });
});
