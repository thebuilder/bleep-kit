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
  decodePng,
  firstDifference,
  noise,
  pixelAt,
  pulse,
  render,
  sine,
} from "./helpers.ts";

interface Img {
  data: Uint8Array;
  height: number;
  width: number;
}
type Rgb = readonly [number, number, number];
interface Box {
  maxX: number;
  maxY: number;
  minX: number;
  minY: number;
}

const isColor = (img: Img, x: number, y: number, rgb: Rgb) =>
  pixelAt(img, x, y).join() === rgb.join();

/** Bounding box of the pixels of exactly this color inside a region (x1 and y1 are exclusive), or null. */
function bounds(
  img: Img,
  rgb: Rgb,
  region: { x0?: number; x1?: number; y0?: number; y1?: number } = {}
): Box | null {
  const { x0 = 0, x1 = img.width, y0 = 0, y1 = img.height } = region;
  const found: Box[] = [];
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (isColor(img, x, y, rgb)) {
        const box = found[0] ?? { maxX: x, maxY: y, minX: x, minY: y };
        box.maxX = Math.max(box.maxX, x);
        box.maxY = Math.max(box.maxY, y);
        box.minX = Math.min(box.minX, x);
        box.minY = Math.min(box.minY, y);
        found[0] = box;
      }
    }
  }
  return found[0] ?? null;
}

/** How many pixels of exactly this color lie inside a region. */
function countIn(
  img: Img,
  rgb: Rgb,
  region: { x0?: number; x1?: number; y0?: number; y1?: number }
): number {
  const { x0 = 0, x1 = img.width, y0 = 0, y1 = img.height } = region;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      n += isColor(img, x, y, rgb) ? 1 : 0;
    }
  }
  return n;
}

/*
 * Layout numbers at the default font scale 2 that several tests rely on (see ImageOptions and chart.ts):
 * margin 12, header 48 px tall (two 16 px lines plus 4), a 78 px gutter for labels left of every plot.
 * The waveform plot therefore starts at x = 90 and ends 12 px before the right edge; the spectrogram plot also
 * starts at x = 90 and leaves 74 px on the right for its color bar.
 */
const HEADER_HEIGHT = 48;
const PLOT_X = 90;
const WAVE_RIGHT_PAD = 12;
const SPECTROGRAM_RIGHT_PAD = 74;

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
      // only the space is blank
      expect(rows.some((row) => row !== 0)).toBe(code !== 32);
    }
    expect(glyphFor("a")).toEqual(glyphFor("A"));
    expect(glyphFor("\u00e9")).toEqual(glyphFor("?"));
  });

  it("gives every capital letter and digit its own shape", () => {
    const names = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
    const shapes = new Set(names.map((c) => glyphFor(c).join(",")));
    expect(shapes.size).toBe(names.length);
  });

  it("measures text as 6 pixels per glyph at scale 1, less the gap after the last one", () => {
    const cv = new Canvas(200, 40);
    expect(cv.text("ABC", 0, 0, PALETTE.fg, 1)).toBe(3 * 6 - 1);
    expect(cv.text("ABC", 0, 0, PALETTE.fg, 2)).toBe(3 * 12 - 2);
  });
});

describe("waveformImage", () => {
  it("makes a 1280 px wide, fully opaque RGBA image whose size follows the content", () => {
    const img = waveformImage(render(SR, sine(SR, 0.3, 440, 0.5)));
    expect(img.width).toBe(1280);
    expect(img.height).toBeGreaterThan(300);
    expect(img.data.length).toBe(img.width * img.height * 4);
    // background colored margin in the corner
    expect(pixelAt(img, 1279, img.height - 1)).toEqual([...PALETTE.bg]);
    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i] !== 255) {
        throw new Error(`pixel ${(i - 3) / 4} is not opaque`);
      }
    }
  });

  it("honors width and height, and draws one lane per channel", () => {
    const left = sine(SR, 0.2, 440, 0.5);
    const mono = waveformImage(
      { channels: [left], events: [], frames: left.length, sampleRate: SR },
      { height: 320, width: 800 }
    );
    expect(mono.width).toBe(800);
    expect(mono.height).toBe(320);
    // the second lane (the right channel) is drawn in the pulse color: only stereo has one
    const stereo = waveformImage(render(SR, left), { height: 320, width: 800 });
    expect(countColor(mono, PALETTE.pulse)).toBe(0);
    expect(countColor(stereo, PALETTE.pulse)).toBeGreaterThan(300);
  });

  it("scales the trace with the amplitude, and zooms in on quiet sounds by powers of two", () => {
    // a square wave in both channels; the right lane is the only place with the pulse color besides its label,
    // so look at columns right of the label. The trace spans the lane's +-amplitude, centered.
    const height = (amp: number) => {
      const wave = pulse(SR, 0.5, 220, amp, 0.5);
      const img = waveformImage(render(SR, wave), SMALL);
      const box = bounds(img, PALETTE.pulse, { x0: 200 });
      expect(box).not.toBeNull();
      return (box?.maxY ?? 0) - (box?.minY ?? 0);
    };
    // 0.9 and 0.5 both fit the full scale lane, so the heights are in proportion
    expect(height(0.5) / height(0.9)).toBeCloseTo(0.5 / 0.9, 1);
    // 0.45 does not: the lane zooms to +-0.5, where 0.45 reaches as high as 0.9 does at +-1
    expect(Math.abs(height(0.45) - height(0.9))).toBeLessThanOrEqual(2);
  });

  it("draws the level panel in the accent color", () => {
    const img = waveformImage(render(SR, sine(SR, 0.5, 220, 0.8)), SMALL);
    expect(countColor(img, PALETTE.accent)).toBeGreaterThan(500);
    expect(countColor(img, PALETTE.pulse)).toBeGreaterThan(500);
  });

  it("marks clipping in red where it happens and nowhere else", () => {
    const clean = waveformImage(render(SR, sine(SR, 0.5, 220, 0.5)), SMALL);
    expect(countColor(clean, PALETTE.danger)).toBe(0);
    // quiet for the first half of the sound, clipped for the second
    const wave = sine(SR, 0.5, 220, 0.3);
    for (let i = wave.length / 2; i < wave.length; i += 1) {
      wave[i] = Math.max(
        -1,
        Math.min(1, Math.sin((2 * Math.PI * 220 * i) / SR) * 1.5)
      );
    }
    const clipped = waveformImage(render(SR, wave), SMALL);
    // below the header text (which also says CLIPPED in red), every red mark is in the right half of the plot
    const plotMiddle = PLOT_X + (480 - PLOT_X - WAVE_RIGHT_PAD) / 2;
    const box = bounds(clipped, PALETTE.danger, { y0: HEADER_HEIGHT });
    expect(
      countIn(clipped, PALETTE.danger, { y0: HEADER_HEIGHT })
    ).toBeGreaterThan(40);
    expect(box?.minX ?? 0).toBeGreaterThanOrEqual(plotMiddle - 3);
    expect(box?.maxX ?? 0).toBeLessThanOrEqual(480 - WAVE_RIGHT_PAD);
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
    // the plot spans from x = 90 to the right margin; a quarter in is the loop start, three quarters the loop end
    const w = img.width - WAVE_RIGHT_PAD - PLOT_X;
    for (const [color, fraction] of [
      [PALETTE.triangle, 0.25],
      [PALETTE.sid, 0.75],
    ] as const) {
      const col = Math.round(PLOT_X + w * fraction);
      expect(
        countIn(img, color, {
          x0: col - 1,
          x1: col + 2,
          y0: 40,
          y1: img.height - 30,
        })
      ).toBeGreaterThan(100);
    }
  });

  it("copes with silence, an empty render and very short sounds, with an image of the same size", () => {
    const sizes = [
      new Float32Array(SR / 2),
      new Float32Array(0),
      sine(SR, 0.002, 440, 0.5),
    ].map((plane) => {
      const img = waveformImage(render(SR, plane), SMALL);
      expect(img.width).toBe(480);
      expect(img.data.length).toBe(img.width * img.height * 4);
      return img.height;
    });
    expect(new Set(sizes).size).toBe(1);
  });

  it("is deterministic, and what the PNG writer stores decodes to the same pixels", () => {
    const r = render(SR, noise(SR, 0.3, 0.5, 3), noise(SR, 0.3, 0.5, 4));
    const a = waveformImage(r, { ...SMALL, title: "TEST" });
    const b = waveformImage(r, { ...SMALL, title: "TEST" });
    expect(firstDifference(a.data, b.data)).toBe(-1);
    const decoded = decodePng(encodePng(a));
    expect(decoded.width).toBe(a.width);
    expect(decoded.height).toBe(a.height);
    expect(firstDifference(decoded.pixels, a.data)).toBe(-1);
  });

  it("draws the title in accent color with the font, and WAVEFORM when none is given", () => {
    const left = sine(SR, 0.3, 440, 0.5);
    const accent = (title?: string) =>
      countColor(
        waveformImage(render(SR, left), {
          ...SMALL,
          ...(title === undefined ? {} : { title }),
        }),
        PALETTE.accent
      );
    // every lit bit of a glyph is a 2 x 2 block at the default font scale 2
    const lit = (text: string) =>
      [...text].reduce(
        (n, c) =>
          n +
          glyphFor(c).reduce(
            (m, row) => m + row.toString(2).replaceAll("0", "").length,
            0
          ),
        0
      );
    expect(accent("COIN") - accent("")).toBe(lit("COIN") * 4);
    expect(accent() - accent("")).toBe(lit("WAVEFORM") * 4);
  });
});

describe("spectrogramImage", () => {
  it("makes a 1280 px wide image that is mostly dark, with a bright spot for a pure tone", () => {
    const img = spectrogramImage(render(SR, sine(SR, 1, 1000, 0.5)));
    expect(img.width).toBe(1280);
    expect(img.height).toBeGreaterThan(300);
    expect(img.data.length).toBe(img.width * img.height * 4);
    let bright = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      // the amber end of the color scale
      if ((img.data[i] ?? 0) > 200 && (img.data[i + 1] ?? 0) > 150) {
        bright += 1;
      }
    }
    expect(bright).toBeGreaterThan(500);
    expect(bright).toBeLessThan(img.data.length / 4 / 20);
  });

  it("draws the loop start and end at their columns of the plot", () => {
    const left = sine(SR, 1, 1000, 0.5);
    const img = spectrogramImage(
      render(SR, left, left, { loopEnd: 40_000, loopStart: 8000 }),
      SMALL
    );
    expect(
      countColor(spectrogramImage(render(SR, left), SMALL), PALETTE.triangle)
    ).toBe(0);
    // the plot runs from x = 90 and leaves 74 px on the right for the color bar; the sound is 48000 frames long
    const w = img.width - SPECTROGRAM_RIGHT_PAD - PLOT_X;
    for (const [color, frame] of [
      [PALETTE.triangle, 8000],
      [PALETTE.sid, 40_000],
    ] as const) {
      const col = Math.round(PLOT_X + (w * frame) / 48_000);
      expect(
        countIn(img, color, {
          x0: col - 2,
          x1: col + 3,
          y0: 56,
          y1: img.height - 40,
        })
      ).toBeGreaterThan(100);
    }
  });

  it("places a tone on the log frequency axis, bright against a dark background", () => {
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
    // amber at the tone, nearly black a quarter of the plot away
    expect(pixelAt(img, col, bestRow)[0]).toBeGreaterThan(200);
    expect(
      pixelAt(img, col, Math.round(expected + plotH * 0.25))[0]
    ).toBeLessThan(60);
    expect(
      pixelAt(img, col, Math.round(expected - plotH * 0.25))[0]
    ).toBeLessThan(60);
  });

  it("marks clipping along the top, only over the stretch that clips", () => {
    const clean = spectrogramImage(render(SR, sine(SR, 0.5, 440, 0.5)), SMALL);
    expect(countColor(clean, PALETTE.danger)).toBe(0);
    // quiet for the first half of the sound, clipped for the second
    const wave = sine(SR, 0.5, 440, 0.3);
    for (let i = wave.length / 2; i < wave.length; i += 1) {
      wave[i] = Math.max(
        -1,
        Math.min(1, Math.sin((2 * Math.PI * 440 * i) / SR) * 1.5)
      );
    }
    const img = spectrogramImage(render(SR, wave), SMALL);
    // the strip sits between the header text (which also says CLIPPED in red, above y = 46) and the plot at y = 56
    const strip = { y0: 46, y1: 56 };
    const plotMiddle = PLOT_X + (480 - PLOT_X - SPECTROGRAM_RIGHT_PAD) / 2;
    const box = bounds(img, PALETTE.danger, strip);
    expect(countIn(img, PALETTE.danger, strip)).toBeGreaterThan(40);
    expect(box?.minX ?? 0).toBeGreaterThanOrEqual(plotMiddle - 3);
    expect(box?.maxX ?? 0).toBeLessThanOrEqual(480 - SPECTROGRAM_RIGHT_PAD);
  });

  it("handles silence, empty and short input and other rates, with an image of the same size", () => {
    const sizes = [
      render(SR, new Float32Array(SR / 4)),
      render(SR, new Float32Array(0)),
      render(SR, sine(SR, 0.01, 440, 0.5)),
      render(22_050, sine(22_050, 0.5, 440, 0.5)),
    ].map((r) => {
      const img = spectrogramImage(r, SMALL);
      expect(img.width).toBe(480);
      expect(img.data.length).toBe(img.width * img.height * 4);
      return img.height;
    });
    expect(new Set(sizes).size).toBe(1);
  });

  it("is deterministic", () => {
    const r = render(SR, noise(SR, 0.4, 0.5, 11));
    expect(
      firstDifference(
        spectrogramImage(r, SMALL).data,
        spectrogramImage(r, SMALL).data
      )
    ).toBe(-1);
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

  // The stem scope of a one stem render: below the header (48 px) and the master scope (104 px) plus gaps (6 px each),
  // at the default font scale 2 each scope is 104 px tall and its trace area starts 22 px below the top of the cell.
  const STEM_PLOT = { y0: 48 + 110 + 22, y1: 48 + 110 + 104 };

  /** Number of separate vertical strokes (runs of columns tall enough to be a jump between the two levels) of a color. */
  function strokes(img: Img, rgb: Rgb): number {
    let count = 0;
    let inside = false;
    for (let x = 0; x < img.width; x += 1) {
      const box = bounds(img, rgb, { ...STEM_PLOT, x0: x, x1: x + 1 });
      const tall = box !== null && box.maxY - box.minY >= 20;
      if (tall && !inside) {
        count += 1;
      }
      inside = tall;
    }
    return count;
  }

  function oneStem(signal: Float32Array, id = "pulse1"): RenderResult {
    return render(SR, signal, signal, { stemIds: [id], stems: [signal] });
  }

  it("shows the stretch that frame points at, and the loudest one when no frame is given", () => {
    const song = new Float32Array(SR);
    song.set(pulse(SR, 0.2, 300, 0.5, 0.5), 30_000);
    const r = oneStem(song);
    const trace = (opts: { frame?: number }) =>
      countIn(
        scopesImage(r, { ...SMALL, ...opts, window: 512 }),
        PALETTE.pulse,
        STEM_PLOT
      );
    expect(trace({ frame: 31_000 })).toBeGreaterThan(300);
    expect(trace({ frame: 2000 })).toBeLessThan(trace({ frame: 31_000 }) / 5);
    expect(trace({})).toBeGreaterThan(300);
  });

  it("shows as many cycles as the window holds", () => {
    // a 300 Hz square wave has a period of 160 frames and two jumps per period; the trigger puts the first at the left edge
    const song = new Float32Array(SR);
    song.set(pulse(SR, 0.5, 300, 0.5, 0.5), 10_000);
    for (const window of [512, 1024, 1536]) {
      const img = scopesImage(oneStem(song), {
        ...SMALL,
        frame: 11_000,
        window,
      });
      expect(
        Math.abs(strokes(img, PALETTE.pulse) - (2 * window) / 160)
      ).toBeLessThanOrEqual(1);
    }
  });

  it("holds the wave still: a rising edge trigger makes different start frames draw the same trace", () => {
    const tone = sine(SR, 1, 440, 0.5);
    const trace = (frame: number) => {
      const img = scopesImage(oneStem(tone), { ...SMALL, frame });
      const set = new Set<number>();
      for (let y = STEM_PLOT.y0; y < STEM_PLOT.y1; y += 1) {
        for (let x = 0; x < img.width; x += 1) {
          if (isColor(img, x, y, PALETTE.pulse)) {
            set.add(y * img.width + x);
          }
        }
      }
      return set;
    };
    const a = trace(10_000);
    // 37 frames later is a third of a period (109 frames): without a trigger the sine would be shifted by that
    const b = trace(10_037);
    let different = 0;
    for (const k of a) {
      different += b.has(k) ? 0 : 1;
    }
    for (const k of b) {
      different += a.has(k) ? 0 : 1;
    }
    expect(a.size).toBeGreaterThan(800);
    expect(different).toBeLessThan(a.size / 8);
  });

  it("draws a silent stem as a flat gray line and labels the others", () => {
    const zero = new Float32Array(2000);
    const silent = scopesImage(oneStem(zero), SMALL);
    const loud = pulse(SR, 0.05, 440, 0.5, 0.5);
    const sounding = scopesImage(oneStem(loud), SMALL);
    // no trace in the channel color: only the name label is pulse colored
    expect(countIn(silent, PALETTE.pulse, STEM_PLOT)).toBe(0);
    expect(countIn(sounding, PALETTE.pulse, STEM_PLOT)).toBeGreaterThan(300);
  });

  it("survives a render shorter than the window", () => {
    const tiny = new Float32Array(100);
    const img = scopesImage(oneStem(tiny), SMALL);
    expect(img.width).toBe(480);
    expect(img.data.length).toBe(img.width * img.height * 4);
  });

  it("is deterministic", () => {
    const r = withStems(SR / 2);
    expect(
      firstDifference(scopesImage(r, SMALL).data, scopesImage(r, SMALL).data)
    ).toBe(-1);
  });
});
