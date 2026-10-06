// `render --json` and `analyze --json` report the same duration, and it is the length of the WAV that was written: the
// length of the audible render, which core trims to the last frame above -90 dBFS plus 10 ms. It is not the sum of the
// envelope times (what the studio's editor shows): on the NES the triangle channel has no volume, so its envelope is a
// gate (level above 0.5 is on, the rule of architecture.md section 2.5, which the engine applies to sfx voices too),
// and a quiet or fast decaying triangle sfx stops long before the envelope ends.

import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeProject, readJson, readWav, run, writeJson } from "./helpers.ts";

interface Coin {
  envelope: { attack: number; decay: number; punch: number; sustain: number };
  volume: number;
  wave: string;
}

async function durations(wave: string): Promise<{
  analyzed: number;
  file: number;
  nominal: number;
  rendered: number;
}> {
  const { project, repo } = await makeProject();
  const file = path.join(project, "sfx", "coin.json");
  const coin = readJson(file) as Coin;
  coin.envelope = { attack: 0, decay: 0.18, punch: 0, sustain: 0 };
  coin.volume = 0.55;
  coin.wave = wave;
  writeJson(file, coin);
  const rendered = await run(repo, ["render", "sfx/coin", "--json"]);
  const analyzed = await run(repo, ["analyze", "sfx/coin", "--json"]);
  expect(rendered.code, rendered.stderr).toBe(0);
  expect(analyzed.code, analyzed.stderr).toBe(0);
  const wav = readWav(path.join(project, "out", "sfx", "coin.wav"));
  return {
    analyzed: analyzed.json.duration,
    file: wav.frames / wav.sampleRate,
    nominal: 0.18,
    rendered: rendered.json.renders[0].duration,
  };
}

describe("duration of an edited sfx", () => {
  it("render and analyze agree, and a gated NES triangle ends before its envelope does", async () => {
    const tri = await durations("triangle");
    expect(tri.analyzed).toBe(tri.rendered);
    expect(tri.rendered).toBeCloseTo(tri.file, 5);
    expect(tri.rendered).toBeLessThan(tri.nominal / 2);
  });

  it("follows the envelope on a wave that has a volume", async () => {
    const sq = await durations("square");
    expect(sq.analyzed).toBe(sq.rendered);
    expect(sq.rendered).toBeCloseTo(sq.file, 5);
    expect(sq.rendered).toBeGreaterThan(sq.nominal - 0.01);
    expect(sq.rendered).toBeLessThan(sq.nominal + 0.05);
  });
});
