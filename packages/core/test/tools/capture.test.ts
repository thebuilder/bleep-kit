import { describe, expect, it } from "vitest";
import { GENESIS_DAC_RATE } from "../../src/chips/genesis.ts";
import { renderSfx } from "../../src/engine/render.ts";
import { defaultSfx } from "../../src/normalize/defaults.ts";
import { decodeSampleData } from "../../src/samples/user.ts";
import { captureSample } from "../../src/tools/capture.ts";
import { dbToAmp, render, sine } from "./helpers.ts";

const SR = 44_100;

/** 100 ms of silence, a 0.2 s 220 Hz tone, then 100 ms of silence. */
function padded() {
  const tone = sine(SR, 0.2, 220, dbToAmp(-6));
  const gap = Math.round(0.1 * SR);
  const out = new Float32Array(tone.length + gap * 2);
  out.set(tone, gap);
  return render(SR, out);
}

describe("captureSample", () => {
  it("cuts the silence and detects the pitch", () => {
    const { notes, sample } = captureSample(padded(), { chip: null });
    expect(sample.baseNote).toBe(57);
    const frames = decodeSampleData(sample).length;
    expect(frames / sample.rate).toBeLessThan(0.23);
    expect(frames / sample.rate).toBeGreaterThan(0.19);
    expect(notes.join(" ")).toContain("silence");
  });

  it("keeps a given base note and does not detect", () => {
    const { sample } = captureSample(padded(), { baseNote: 40, chip: null });
    expect(sample.baseNote).toBe(40);
    expect(sample.finetune).toBe(0);
  });

  it("stores for the chip: 8 bit at the Paula rate on the Amiga, the DAC rate on the Genesis", () => {
    const amiga = captureSample(padded(), { chip: "amiga" }).sample;
    expect(amiga.bits).toBe(8);
    expect(amiga.rate).toBe(16_574);
    const genesis = captureSample(padded(), { chip: "genesis" }).sample;
    expect(genesis.bits).toBe(8);
    expect(genesis.rate).toBe(Math.round(GENESIS_DAC_RATE));
  });

  it("crushes to 8 bit and a low rate on request", () => {
    const hi = captureSample(padded(), { chip: "snes" }).sample;
    expect(hi.bits).toBe(16);
    const lo = captureSample(padded(), {
      bits: 8,
      chip: "snes",
      rate: 8000,
    }).sample;
    expect(lo.bits).toBe(8);
    expect(lo.rate).toBe(8000);
    expect(decodeSampleData(lo).length).toBeLessThan(
      decodeSampleData(hi).length
    );
  });

  it("makes a sample out of a rendered sfx", () => {
    const sfx = defaultSfx("nes");
    const { sample } = captureSample(renderSfx(sfx), { chip: "amiga" });
    expect(decodeSampleData(sample).length).toBeGreaterThan(100);
  });

  it("says so when the render is silent", () => {
    const { notes, sample } = captureSample(
      render(SR, new Float32Array(SR / 10)),
      { chip: null }
    );
    expect(notes.join(" ")).toContain("silent");
    expect(decodeSampleData(sample).length).toBeGreaterThanOrEqual(1);
  });
});
