import { describe, expect, it } from "vitest";
import { Canvas, PALETTE } from "../../src/tools/canvas.ts";
import { glyphFor } from "../../src/tools/font.ts";
import {
  scopesImage,
  spectrogramImage,
  waveformImage,
} from "../../src/tools/images.ts";
import { encodePng } from "../../src/tools/png.ts";
import type { RenderResult } from "../../src/types.ts";
import {
  countColor,
  decodeStoredPng,
  hashBytes,
  noise,
  pixelAt,
  pulse,
  render,
  sine,
} from "./helpers.ts";

const SR = 48_000;
/** Small images keep the suite quick; one test checks the default size. */
const SMALL = { width: 480 };

function withStems(frames: number): RenderResult {
  const a = pulse(SR, frames / SR, 440, 0.4, 0.25);
  const b = sine(SR, frames / SR, 220, 0.3);
  const c = noise(SR, frames / SR, 0.2);
  const mix = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    mix[i] = (a[i] ?? 0) + (b[i] ?? 0) + (c[i] ?? 0);
  }
  return render(SR, mix, mix, {
    stemIds: ["pulse1", "triangle", "noise"],
    stems: [a, b, c],
  });
}

describe("canvas and font", () => {
  it("draws a glyph where its bitmap says", () => {
    const cv = new Canvas(20, 20);
    cv.text("I", 2, 3, PALETTE.fg, 1);
    // "I" is .###. / ..#.. x5 / .###.
    const lit = (x: number, y: number) =>
      pixelAt(cv, x, y).join() === PALETTE.fg.join();
    expect(lit(3, 3)).toBe(true);
    expect(lit(5, 3)).toBe(true);
    expect(lit(2, 3)).toBe(false);
    expect(lit(4, 5)).toBe(true);
    expect(lit(3, 5)).toBe(false);
    expect(lit(4, 9)).toBe(true);
  });

  it("scales glyphs, clips at the edges and blends with alpha", () => {
    const cv = new Canvas(8, 8);
    cv.text("H", 6, 6, PALETTE.fg, 3);
    cv.rect(0, 0, 2, 2, [255, 255, 255], 0.5);
    expect(pixelAt(cv, 0, 0)[0]).toBe(Math.round((PALETTE.bg[0] + 255) / 2));
    expect(pixelAt(cv, 7, 7)).toEqual([...PALETTE.fg]);
  });

  it("has a seven row glyph for every printable ASCII character, upper and lower case alike", () => {
    for (let code = 32; code < 127; code += 1) {
      const rows = glyphFor(String.fromCharCode(code));
      expect(rows).toHaveLength(7);
      for (const row of rows) {
        expect(row).toBeLessThan(32);
      }
    }
    expect(glyphFor("a")).toEqual(glyphFor("A"));
    expect(glyphFor("\u00e9")).toEqual(glyphFor("?"));
  });

  it("measures text consistently", () => {
    const cv = new Canvas(200, 40);
    expect(cv.text("ABC", 0, 0, PALETTE.fg, 2)).toBe(3 * 12 - 2);
  });
});

describe("waveformImage", () => {
  it("makes a 1280 px wide RGBA image whose size follows the content", () => {
    const img = waveformImage(render(SR, sine(SR, 0.3, 440, 0.5)));
    expect(img.width).toBe(1280);
    expect(img.height).toBeGreaterThan(300);
    expect(img.data.length).toBe(img.width * img.height * 4);
    // fully opaque, background colored margin
    expect(pixelAt(img, 1279, img.height - 1)).toEqual([...PALETTE.bg]);
    expect(img.data[3]).toBe(255);
  });

  it("honors width, height and a single channel", () => {
    const left = sine(SR, 0.2, 440, 0.5);
    const img = waveformImage(
      { channels: [left], events: [], frames: left.length, sampleRate: SR },
      { height: 320, width: 800 }
    );
    expect(img.width).toBe(800);
    expect(img.height).toBe(320);
  });

  it("draws the waveform in the channel colors and the level panel in the accent", () => {
    const img = waveformImage(render(SR, sine(SR, 0.5, 220, 0.8)), SMALL);
    expect(countColor(img, PALETTE.accent)).toBeGreaterThan(500);
    expect(countColor(img, PALETTE.pulse)).toBeGreaterThan(500);
  });

  it("marks clipping in red and nothing red without clipping", () => {
    const clean = waveformImage(render(SR, sine(SR, 0.5, 220, 0.5)), SMALL);
    expect(countColor(clean, PALETTE.danger)).toBe(0);
    const hot = sine(SR, 0.5, 220, 1);
    for (let i = 0; i < hot.length; i += 1) {
      hot[i] = Math.max(-1, Math.min(1, (hot[i] ?? 0) * 1.5));
    }
    const clipped = waveformImage(render(SR, hot), SMALL);
    expect(countColor(clipped, PALETTE.danger)).toBeGreaterThan(300);
  });

  it("draws loop markers only when the render loops", () => {
    const left = sine(SR, 2, 220, 0.5);
    const plain = waveformImage(render(SR, left), SMALL);
    const looped = waveformImage(
      render(SR, left, left, { loopEnd: 70_000, loopStart: 20_000 }),
      SMALL
    );
    expect(countColor(plain, PALETTE.triangle)).toBe(0);
    expect(countColor(looped, PALETTE.triangle)).toBeGreaterThan(50);
    expect(countColor(looped, PALETTE.sid)).toBeGreaterThan(50);
  });

  it("draws loop lines at the right columns", () => {
    const left = sine(SR, 1, 220, 0.5);
    const img = waveformImage(
      render(SR, left, left, { loopEnd: 36_000, loopStart: 12_000 })
    );
    // plot spans from x = margin + gutter to width - margin; a quarter in is the loop start
    const x0 = 12 + 12 * 6 + 6;
    const w = img.width - 12 - x0;
    const col = Math.round(x0 + w * 0.25);
    let found = false;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let y = 40; y < img.height - 30; y += 1) {
        if (pixelAt(img, col + dx, y).join() === PALETTE.triangle.join()) {
          found = true;
        }
      }
    }
    expect(found).toBe(true);
  });

  it("copes with silence, an empty render and very short sounds", () => {
    expect(
      waveformImage(render(SR, new Float32Array(SR / 2)), SMALL).width
    ).toBe(480);
    expect(waveformImage(render(SR, new Float32Array(0)), SMALL).width).toBe(
      480
    );
    expect(
      waveformImage(render(SR, sine(SR, 0.002, 440, 0.5)), SMALL).width
    ).toBe(480);
  });

  it("is deterministic and survives the PNG writer", () => {
    const r = render(SR, noise(SR, 0.3, 0.5, 3), noise(SR, 0.3, 0.5, 4));
    const a = waveformImage(r, { ...SMALL, title: "TEST" });
    const b = waveformImage(r, { ...SMALL, title: "TEST" });
    expect(hashBytes(a.data)).toBe(hashBytes(b.data));
    const decoded = decodeStoredPng(encodePng(a));
    expect(decoded.width).toBe(a.width);
    expect(hashBytes(decoded.pixels)).toBe(hashBytes(a.data));
  });

  it("puts the title in the header", () => {
    const left = sine(SR, 0.3, 440, 0.5);
    const titled = waveformImage(render(SR, left), { ...SMALL, title: "COIN" });
    const plain = waveformImage(render(SR, left), { ...SMALL, title: "" });
    expect(countColor(titled, PALETTE.accent)).toBeGreaterThan(
      countColor(plain, PALETTE.accent)
    );
  });
});

describe("spectrogramImage", () => {
  it("makes an image with a color scale and a loop marker", () => {
    const left = sine(SR, 1, 1000, 0.5);
    const img = spectrogramImage(
      render(SR, left, left, { loopEnd: 40_000, loopStart: 8000 })
    );
    expect(img.width).toBe(1280);
    expect(img.height).toBeGreaterThan(300);
    expect(countColor(img, PALETTE.triangle)).toBeGreaterThan(30);
    // a pure tone is bright (amber end of the scale) somewhere and dark elsewhere
    let bright = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if ((img.data[i] ?? 0) > 200 && (img.data[i + 1] ?? 0) > 150) {
        bright += 1;
      }
    }
    expect(bright).toBeGreaterThan(500);
  });

  it("places a tone on the log frequency axis", () => {
    const sr = SR;
    const hz = 1000;
    const img = spectrogramImage(render(sr, sine(sr, 1, hz, 0.5)), {
      height: 420,
      width: 1000,
    });
    // the plot runs 20 Hz to Nyquist; find the row with the most energy in a column near the middle
    const col = 400;
    let bestRow = -1;
    let best = -1;
    for (let y = 40; y < img.height - 40; y += 1) {
      const [r, g] = pixelAt(img, col, y);
      if (r + g > best) {
        best = r + g;
        bestRow = y;
      }
    }
    // rows from the top of the plot: header (headerHeight 12 + 2 * 16 + 4 = 48) plus the clip strip (8)
    const plotTop = 56;
    const plotH = img.height - plotTop - (16 + 10) - 12;
    const expected =
      plotTop + plotH * (1 - Math.log(hz / 20) / Math.log(sr / 2 / 20));
    expect(Math.abs(bestRow - expected)).toBeLessThan(plotH * 0.04);
  });

  it("marks clipping along the top", () => {
    const hot = sine(SR, 0.5, 440, 1.4);
    for (let i = 0; i < hot.length; i += 1) {
      hot[i] = Math.max(-1, Math.min(1, hot[i] ?? 0));
    }
    expect(
      countColor(spectrogramImage(render(SR, hot), SMALL), PALETTE.danger)
    ).toBeGreaterThan(100);
    expect(
      countColor(
        spectrogramImage(render(SR, sine(SR, 0.5, 440, 0.5)), SMALL),
        PALETTE.danger
      )
    ).toBe(0);
  });

  it("handles silence, empty and short input and other rates", () => {
    expect(
      spectrogramImage(render(SR, new Float32Array(SR / 4)), SMALL).width
    ).toBe(480);
    expect(spectrogramImage(render(SR, new Float32Array(0)), SMALL).width).toBe(
      480
    );
    expect(
      spectrogramImage(render(SR, sine(SR, 0.01, 440, 0.5)), SMALL).width
    ).toBe(480);
    expect(
      spectrogramImage(render(22_050, sine(22_050, 0.5, 440, 0.5)), SMALL).width
    ).toBe(480);
  });

  it("is deterministic", () => {
    const r = render(SR, noise(SR, 0.4, 0.5, 11));
    expect(hashBytes(spectrogramImage(r, SMALL).data)).toBe(
      hashBytes(spectrogramImage(r, SMALL).data)
    );
  });
});

describe("scopesImage", () => {
  it("needs stems", () => {
    expect(() => scopesImage(render(SR, sine(SR, 0.2, 440, 0.5)))).toThrow(
      "stems"
    );
    expect(() =>
      scopesImage(render(SR, sine(SR, 0.2, 440, 0.5), undefined, { stems: [] }))
    ).toThrow("stems");
  });

  it("draws a master scope and one per stem, colored by channel kind", () => {
    const img = scopesImage(withStems(SR / 2));
    expect(img.width).toBe(1280);
    expect(countColor(img, PALETTE.pulse)).toBeGreaterThan(200);
    expect(countColor(img, PALETTE.triangle)).toBeGreaterThan(200);
    expect(countColor(img, PALETTE.noise)).toBeGreaterThan(200);
    expect(countColor(img, PALETTE.fg)).toBeGreaterThan(200);
  });

  it("grows with the number of stems and honors an explicit height", () => {
    const base = withStems(SR / 2);
    const [first] = base.stems ?? [];
    const one = scopesImage(
      { ...base, stemIds: ["pulse1"], stems: first ? [first] : [] },
      SMALL
    );
    const three = scopesImage(base, SMALL);
    expect(three.height).toBeGreaterThan(one.height);
    // more than three stems go into two columns, so six stems take as many rows as three
    const stems = [...(base.stems ?? []), ...(base.stems ?? [])];
    const six = scopesImage(
      {
        ...base,
        stemIds: ["pulse1", "pulse2", "tri", "noise", "wave", "fm1"],
        stems,
      },
      SMALL
    );
    expect(six.height).toBe(three.height);
    expect(scopesImage(base, { ...SMALL, height: 400 }).height).toBe(400);
  });

  it("follows frame and window options", () => {
    const quiet = new Float32Array(SR);
    const loud = pulse(SR, 0.2, 300, 0.5, 0.5);
    const song = new Float32Array(SR);
    song.set(loud, 30_000);
    const r = render(SR, song, song, { stemIds: ["pulse1"], stems: [song] });
    const atLoud = scopesImage(r, { ...SMALL, frame: 31_000, window: 512 });
    const atQuiet = scopesImage(r, { ...SMALL, frame: 2000, window: 512 });
    expect(countColor(atLoud, PALETTE.pulse)).toBeGreaterThan(
      countColor(atQuiet, PALETTE.pulse)
    );
    // the default picks the loud part by itself
    expect(
      countColor(scopesImage(r, { ...SMALL, window: 512 }), PALETTE.pulse)
    ).toBeGreaterThan(countColor(atQuiet, PALETTE.pulse));
    expect(quiet.length).toBe(SR);
  });

  it("says SILENT for a silent stem and survives short renders", () => {
    const zero = new Float32Array(2000);
    const silent = scopesImage(
      render(SR, zero, zero, { stemIds: ["pulse1"], stems: [zero] }),
      SMALL
    );
    const loud = pulse(SR, 0.05, 440, 0.5, 0.5);
    const sounding = scopesImage(
      render(SR, loud, loud, { stemIds: ["pulse1"], stems: [loud] }),
      SMALL
    );
    // a silent stem draws a gray flat line, not a trace in the channel color
    expect(countColor(silent, PALETTE.pulse)).toBeLessThan(
      countColor(sounding, PALETTE.pulse) / 3
    );
    const tiny = new Float32Array(100);
    expect(
      scopesImage(
        render(SR, tiny, tiny, { stemIds: ["pulse1"], stems: [tiny] }),
        SMALL
      ).width
    ).toBe(480);
  });

  it("is deterministic", () => {
    const r = withStems(SR / 2);
    expect(hashBytes(scopesImage(r, SMALL).data)).toBe(
      hashBytes(scopesImage(r, SMALL).data)
    );
  });
});
