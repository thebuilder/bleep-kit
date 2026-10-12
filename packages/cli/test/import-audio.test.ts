import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeProject, readJson, run } from "./helpers.ts";

/* A WAV and a ProTracker module built byte by byte, imported through the CLI. */

function wav(rate: number, frames: number, hz: number): Uint8Array {
  const out = new Uint8Array(44 + frames * 2);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      out[at + i] = text.charCodeAt(i);
    }
  };
  tag(0, "RIFF");
  view.setUint32(4, 36 + frames * 2, true);
  tag(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    view.setInt16(
      44 + i * 2,
      Math.round(20_000 * Math.sin((2 * Math.PI * hz * i) / rate)),
      true
    );
  }
  return out;
}

/** One pattern: a C-2 and an E-2 on channel 1 with one sample (a 64 byte ramp looping over its second half). */
function mod(): Uint8Array {
  const b = new Uint8Array(1084 + 1024 + 64);
  b.set(
    [..."ramp"].map((c) => c.charCodeAt(0)),
    20
  );
  b[20 + 23] = 32;
  b[20 + 25] = 64;
  b[20 + 27] = 16;
  b[20 + 29] = 16;
  b[950] = 1;
  b.set(
    [..."M.K."].map((c) => c.charCodeAt(0)),
    1080
  );
  const cell = (row: number, period: number, sample: number) => {
    const o = 1084 + row * 16;
    b[o] = Math.floor(sample / 16) * 16 + Math.floor(period / 256);
    b[o + 1] = period % 256;
    b[o + 2] = (sample % 16) * 16;
  };
  cell(0, 428, 1);
  cell(4, 340, 1);
  for (let i = 0; i < 64; i += 1) {
    b[1084 + 1024 + i] = (i * 4 - 128 + 256) % 256;
  }
  return b;
}

describe("import sample", () => {
  it("writes samples/<id>.json mono, resampled and 8 bit for the amiga, with the detected pitch", async () => {
    const { project } = await makeProject("amiga");
    const file = path.join(project, "tone.wav");
    fs.writeFileSync(file, wav(44_100, 11_025, 220));
    const r = await run(project, ["import", "sample", "tone.wav", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      baseNote: 57,
      ok: true,
      path: "samples/tone.json",
    });
    const doc = readJson(path.join(project, "samples/tone.json")) as Record<
      string,
      unknown
    >;
    expect(doc).toMatchObject({ baseNote: 57, bits: 8, rate: 16_574 });
    expect(doc).not.toHaveProperty("id");
    const again = await run(project, ["import", "sample", "tone.wav"]);
    expect(again.code).toBe(1);
    const forced = await run(project, [
      "import",
      "sample",
      "tone.wav",
      "--base-note",
      "C-4",
      "--force",
      "--json",
    ]);
    expect(forced.json.baseNote).toBe(60);
  });

  it("new instrument --sample points a sample instrument at an imported sample", async () => {
    const { project } = await makeProject("amiga");
    fs.writeFileSync(path.join(project, "tone.wav"), wav(22_050, 2000, 440));
    await run(project, ["import", "sample", "tone.wav"]);
    const r = await run(project, [
      "new",
      "instrument",
      "hit",
      "--kind",
      "sample",
      "--sample",
      "tone",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const inst = readJson(path.join(project, "instruments/hit.json")) as {
      sample: { userSample: string };
    };
    expect(inst.sample.userSample).toBe("tone");
    const bad = await run(project, [
      "new",
      "instrument",
      "x",
      "--kind",
      "sample",
      "--sample",
      "ghost",
    ]);
    expect(bad.code).toBe(0);
    expect(
      (await run(project, ["validate"])).stdout +
        (await run(project, ["validate", "--json"])).stdout
    ).toContain("ghost");
    const wrong = await run(project, [
      "new",
      "instrument",
      "y",
      "--kind",
      "pulse",
      "--sample",
      "tone",
    ]);
    expect(wrong.code).toBe(2);
  });

  it("says WAV only for other formats", async () => {
    const { project } = await makeProject("amiga");
    fs.writeFileSync(path.join(project, "a.mp3"), "ID3");
    const r = await run(project, ["import", "sample", "a.mp3"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("WAV only");
  });

  it("lists samples and validates the project", async () => {
    const { project } = await makeProject("amiga");
    fs.writeFileSync(path.join(project, "tone.wav"), wav(22_050, 2000, 440));
    await run(project, ["import", "sample", "tone.wav"]);
    const list = await run(project, ["list", "samples", "--json"]);
    expect(list.json.samples).toHaveLength(1);
    expect(list.json.samples[0]).toMatchObject({ bits: 8, id: "tone" });
    expect((await run(project, ["validate", "--json"])).code).toBe(0);
  });
});

describe("import a MOD and export it again", () => {
  it("writes the song, the instruments and the samples, and renders", async () => {
    const { project } = await makeProject("amiga");
    fs.writeFileSync(path.join(project, "tune.mod"), mod());
    const r = await run(project, ["import", "tune.mod", "--json"]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      chip: "amiga",
      ok: true,
      samples: ["samples/tune-01-ramp.json"],
    });
    const song = readJson(path.join(project, "songs/tune.json")) as {
      patterns: Record<string, { tracks: { ch1: { note: number }[] } }>;
      order: string[];
    };
    const first = song.patterns[song.order[0] ?? ""];
    expect(first?.tracks.ch1.map((x) => x.note)).toEqual([36, 40]);
    const render = await run(project, ["render", "song/tune", "--json"]);
    expect(render.code).toBe(0);
    const out = path.join(project, "round.mod");
    const exported = await run(project, [
      "export",
      "mod",
      "song/tune",
      "--out",
      out,
      "--json",
    ]);
    expect(exported.code).toBe(0);
    const bytes = fs.readFileSync(out);
    expect(bytes.subarray(1080, 1084).toString("latin1")).toBe("M.K.");
    expect(bytes[20 + 25]).toBe(64);
  });

  it("refuses to export a song of another chip to MOD", async () => {
    const { project } = await makeProject("nes");
    await run(project, ["new", "song", "demo", "--chip", "nes"]);
    const r = await run(project, ["export", "mod", "song/demo"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("only amiga songs");
  });
});

describe("resample", () => {
  it("records an sfx and an instrument note as samples", async () => {
    const { project } = await makeProject("amiga");
    const made = await run(project, [
      "new",
      "sfx",
      "zap",
      "--category",
      "laser",
      "--chip",
      "amiga",
    ]);
    expect(made.code).toBe(0);
    const r = await run(project, [
      "resample",
      "sfx/zap",
      "--id",
      "zap-sample",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      bits: 8,
      ok: true,
      path: "samples/zap-sample.json",
    });
    expect(
      (readJson(path.join(project, "samples/zap-sample.json")) as { rate: number })
        .rate
    ).toBe(16_574);
    const again = await run(project, ["resample", "sfx/zap", "--id", "zap-sample"]);
    expect(again.code).toBe(1);
    const crushed = await run(project, [
      "resample",
      "sfx/zap",
      "--id",
      "zap-8k",
      "--rate",
      "8000",
      "--json",
    ]);
    expect(crushed.json).toMatchObject({ bits: 8, rate: 8000 });
    const bad = await run(project, ["resample", "sfx/zap", "--id", "z3", "--bits", "12"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr + bad.stdout).toContain("--bits must be 8 or 16");
  });

  it("records an instrument note for the Genesis DAC", async () => {
    const { project } = await makeProject("genesis");
    const made = await run(project, [
      "new",
      "instrument",
      "slap",
      "--kind",
      "fm",
      "--chip",
      "genesis",
    ]);
    expect(made.code).toBe(0);
    const r = await run(project, [
      "resample",
      "instrument/slap",
      "--note",
      "C-2",
      "--id",
      "slap-hit",
      "--json",
    ]);
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ baseNote: 36, bits: 8, rate: 12_969 });
  });
});
