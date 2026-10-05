import type { RenderResult } from "../types.ts";
import { mixToMono } from "./buffers.ts";
import {
  type Canvas,
  lineHeight,
  PALETTE,
  type Rgb,
  textWidth,
} from "./canvas.ts";
import {
  colorForChannel,
  drawHeader,
  drawLoopMarkers,
  drawTimeAxis,
  drawTimeGrid,
  type Frame,
  type ImageOptions,
  newFrame,
  niceStep,
  type Rect,
  timeTicks,
} from "./chart.ts";
import { measureDutyCycle } from "./duty.ts";
import { ampToDb, DB_FLOOR, hzToNoteName } from "./format.ts";
import { estimatePitch } from "./pitch.ts";
import type { PngImage } from "./png.ts";
import { createSpectrumWork, windowedMagSq } from "./spectrum.ts";

export type { ImageOptions } from "./chart.ts";

const CLIP_LEVEL = 0.999;
const MAX_WAVE_PANELS = 8;
const PANEL_GAP = 6;
const DB_STEP = 12;
const DILATE_FROM_SPC = 3;
const CLIP_CAP = 4;

/* ---------- shared pieces ---------- */

function panelRects(
  plotX: number,
  plotW: number,
  top: number,
  panelHeight: number,
  count: number
): Rect[] {
  const rects: Rect[] = [];
  for (let i = 0; i < count; i += 1) {
    rects.push({
      h: panelHeight,
      w: plotW,
      x: plotX,
      y: top + i * (panelHeight + PANEL_GAP),
    });
  }
  return rects;
}

function drawPanelBox(cv: Canvas, p: Rect): void {
  cv.rect(p.x, p.y, p.w, p.h, PALETTE.panel);
  cv.frame(p.x, p.y, p.w, p.h, PALETTE.line);
}

/** Linear interpolation of a channel at a fractional sample position. */
function interp(plane: Float32Array, pos: number): number {
  const i = Math.floor(pos);
  const f = pos - i;
  const a = plane[Math.min(i, plane.length - 1)] ?? 0;
  const b = plane[Math.min(i + 1, plane.length - 1)] ?? 0;
  return a + (b - a) * f;
}

/* ---------- waveform ---------- */

interface Columns {
  /** RMS over all channels per column. */
  allRms: Float32Array;
  clip: Uint8Array;
  max: Float32Array[];
  min: Float32Array[];
  /** Peak of every channel per column. */
  peak: Float32Array;
  rms: Float32Array[];
}

/** Min, max and mean square of one channel over the samples [a, b], plus whether any sample clips. */
function channelColumn(
  plane: Float32Array,
  a: number,
  b: number
): { lo: number; hi: number; meanSq: number; clip: boolean } {
  const i0 = Math.ceil(a);
  const i1 = Math.max(i0, Math.ceil(b));
  let lo = Math.min(interp(plane, a), interp(plane, b));
  let hi = Math.max(interp(plane, a), interp(plane, b));
  let sq = 0;
  let count = 0;
  let clip = false;
  for (let i = i0; i < i1 && i < plane.length; i += 1) {
    const v = plane[i] ?? 0;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    sq += v * v;
    count += 1;
    clip = clip || Math.abs(v) >= CLIP_LEVEL;
  }
  // reach the first sample of the next column, so a step between columns is drawn as an edge
  const bridge = plane[i1] ?? plane[i0] ?? 0;
  const meanSq = count > 0 ? sq / count : interp(plane, (a + b) / 2) ** 2;
  return { clip, hi: Math.max(hi, bridge), lo: Math.min(lo, bridge), meanSq };
}

function columnStats(r: RenderResult, width: number): Columns {
  const n = r.channels.length;
  const cols: Columns = {
    allRms: new Float32Array(width),
    clip: new Uint8Array(width),
    max: r.channels.map(() => new Float32Array(width)),
    min: r.channels.map(() => new Float32Array(width)),
    peak: new Float32Array(width),
    rms: r.channels.map(() => new Float32Array(width)),
  };
  const spc = r.frames / width;
  for (let x = 0; x < width; x += 1) {
    const a = x * spc;
    const b = Math.min(r.frames - 1, (x + 1) * spc);
    let allSq = 0;
    for (let c = 0; c < n; c += 1) {
      const plane = r.channels[c];
      const m = cols.min[c];
      const M = cols.max[c];
      const R = cols.rms[c];
      if (!(plane && m && M && R)) {
        continue;
      }
      const col = channelColumn(plane, a, b);
      m[x] = col.lo;
      M[x] = col.hi;
      R[x] = Math.sqrt(col.meanSq);
      cols.peak[x] = Math.max(
        cols.peak[x] ?? 0,
        Math.abs(col.lo),
        Math.abs(col.hi)
      );
      cols.clip[x] = (cols.clip[x] ?? 0) | (col.clip ? 1 : 0);
      allSq += col.meanSq;
    }
    cols.allRms[x] = Math.sqrt(allSq / Math.max(1, n));
  }
  if (spc >= DILATE_FROM_SPC) {
    for (const m of cols.min) {
      dilate(m, Math.min);
    }
    for (const m of cols.max) {
      dilate(m, Math.max);
    }
  }
  return cols;
}

/** Widen each column's range to take in its neighbors, so dense waveforms read as a solid band instead of hatching. */
function dilate(
  values: Float32Array,
  pick: (a: number, b: number) => number
): void {
  const copy = values.slice();
  for (let x = 0; x < values.length; x += 1) {
    const here = copy[x] ?? 0;
    values[x] = pick(pick(copy[x - 1] ?? here, here), copy[x + 1] ?? here);
  }
}

/** The smallest power-of-two fraction of full scale (or multiple, above it) that holds the peak. */
function waveRange(peak: number): number {
  let range = 1;
  while (range < peak) {
    range *= 2;
  }
  while (range / 2 >= peak * 1.05 && range > 2 ** -14) {
    range /= 2;
  }
  return range;
}

function channelNames(count: number): string[] {
  if (count === 1) {
    return ["MONO"];
  }
  if (count === 2) {
    return ["L", "R"];
  }
  return Array.from({ length: count }, (_, i) => `CH${i + 1}`);
}

function dbLabel(range: number, fraction: number): string {
  const db = ampToDb(range * fraction);
  return `${Math.round(db)} DB`;
}

/** A label on a dark chip so it reads over a filled waveform. */
function drawTag(
  cv: Canvas,
  text: string,
  x: number,
  y: number,
  color: Rgb,
  scale: number
): void {
  cv.rect(
    x,
    y - 2,
    textWidth(text, scale) + 6,
    lineHeight(scale) + 1,
    PALETTE.bg,
    0.85
  );
  cv.text(text, x + 3, y, color, scale);
}

function drawWaveLabels(
  cv: Canvas,
  p: Rect,
  range: number,
  name: string,
  color: Rgb,
  scale: number
): void {
  const lh = lineHeight(scale);
  const mid = p.y + p.h / 2;
  const reach = p.h / 2 - 3;
  cv.hline(mid, p.x + 1, p.x + p.w - 2, PALETTE.line);
  cv.hline(mid - reach / 2, p.x + 1, p.x + p.w - 2, PALETTE.line, 0.6, 3);
  cv.hline(mid + reach / 2, p.x + 1, p.x + p.w - 2, PALETTE.line, 0.6, 3);
  if (range > 1) {
    const fsY = mid - reach / range;
    cv.hline(fsY, p.x + 1, p.x + p.w - 2, PALETTE.danger, 0.8, 3);
    cv.hline(2 * mid - fsY, p.x + 1, p.x + p.w - 2, PALETTE.danger, 0.8, 3);
  }
  const gx = p.x - 6;
  cv.textRight(dbLabel(range, 1), gx, p.y + 2, PALETTE.muted, scale);
  cv.textRight(
    dbLabel(range, 0.5),
    gx,
    mid - reach / 2 - lh / 2 + 1,
    PALETTE.muted,
    scale
  );
  cv.textRight(
    dbLabel(range, 0.5),
    gx,
    mid + reach / 2 - lh / 2 + 1,
    PALETTE.muted,
    scale,
    0.5
  );
  cv.textRight(
    dbLabel(range, 1),
    gx,
    p.y + p.h - lh + 1,
    PALETTE.muted,
    scale,
    0.5
  );
  drawTag(cv, name, p.x + 4, p.y + 4, color, scale);
}

function drawWaveColumns(
  cv: Canvas,
  p: Rect,
  cols: Columns,
  c: number,
  range: number,
  color: Rgb
): void {
  const mid = p.y + p.h / 2;
  const reach = p.h / 2 - 3;
  const yOf = (v: number): number => mid - (v / range) * reach;
  const mins = cols.min[c];
  const maxs = cols.max[c];
  const rmss = cols.rms[c];
  if (!(mins && maxs && rmss)) {
    return;
  }
  for (let x = 0; x < p.w - 2; x += 1) {
    const lo = mins[x] ?? 0;
    const hi = maxs[x] ?? 0;
    const top = yOf(hi);
    const bottom = yOf(lo);
    const px = p.x + 1 + x;
    cv.rect(px, top, 1, Math.max(1, bottom - top), color, 0.55);
    const rms = rmss[x] ?? 0;
    const from = Math.max(top, yOf(rms));
    cv.rect(
      px,
      from,
      1,
      Math.max(1, Math.min(bottom, yOf(-rms)) - from),
      color,
      1
    );
    // clipping: red caps where the column reaches full scale
    if (hi >= CLIP_LEVEL) {
      cv.rect(px, top, 1, CLIP_CAP, PALETTE.danger);
    }
    if (lo <= -CLIP_LEVEL) {
      cv.rect(px, bottom - CLIP_CAP + 1, 1, CLIP_CAP, PALETTE.danger);
    }
  }
}

function levelBottom(cols: Columns): number {
  let lowest = 0;
  for (const v of cols.allRms) {
    const db = ampToDb(v);
    if (db > -119) {
      lowest = Math.min(lowest, db);
    }
  }
  return -Math.min(72, Math.max(48, Math.ceil(-lowest / DB_STEP) * DB_STEP));
}

function drawLevelGrid(
  cv: Canvas,
  p: Rect,
  bottomDb: number,
  scale: number,
  over: boolean
): void {
  const reach = p.h - 4;
  const lh = lineHeight(scale);
  const yOf = (db: number): number => p.y + 2 + (db / bottomDb) * reach;
  // label every step that fits, else every second one
  const labelEvery =
    (reach / (-bottomDb / DB_STEP) >= lh + 1 ? 1 : 2) * DB_STEP;
  for (let db = 0; db >= bottomDb; db -= DB_STEP) {
    const y = yOf(db);
    if (over) {
      cv.hline(y, p.x + 1, p.x + p.w - 2, PALETTE.bg, 0.35, 3);
    } else {
      cv.hline(y, p.x + 1, p.x + p.w - 2, PALETTE.line, 1, db === 0 ? 0 : 3);
      if (-db % labelEvery === 0) {
        const ty = Math.min(p.y + p.h - lh, Math.max(p.y, y - lh / 2 + 1));
        cv.textRight(`${db} DB`, p.x - 6, ty, PALETTE.muted, scale);
      }
    }
  }
}

function drawLevelPanel(
  cv: Canvas,
  p: Rect,
  cols: Columns,
  scale: number
): void {
  const bottomDb = levelBottom(cols);
  const reach = p.h - 4;
  const yOf = (db: number): number =>
    p.y + 2 + (Math.min(0, Math.max(bottomDb, db)) / bottomDb) * reach;
  drawLevelGrid(cv, p, bottomDb, scale, false);
  let prev = -1;
  for (let x = 0; x < p.w - 2; x += 1) {
    const rmsY = yOf(ampToDb(cols.allRms[x] ?? 0));
    cv.rect(p.x + 1 + x, rmsY, 1, p.y + p.h - 1 - rmsY, PALETTE.accent, 0.8);
    const peakY = yOf(ampToDb(cols.peak[x] ?? 0));
    if (prev >= 0) {
      cv.vline(
        p.x + 1 + x,
        Math.min(prev, peakY),
        Math.max(prev, peakY),
        PALETTE.fg,
        0.9
      );
    } else {
      cv.px(p.x + 1 + x, Math.round(peakY), PALETTE.fg);
    }
    prev = peakY;
    if (cols.clip[x] === 1) {
      cv.rect(p.x + 1 + x, p.y + 1, 1, 4, PALETTE.danger);
    }
  }
  drawLevelGrid(cv, p, bottomDb, scale, true);
  drawTag(cv, "LEVEL", p.x + 4, p.y + 4, PALETTE.accent, scale);
  const legendX = p.x + p.w - 8;
  const peakW = textWidth("PEAK", scale) + 6;
  cv.rect(
    legendX - peakW,
    p.y + 2,
    peakW + 4,
    lineHeight(scale) + 1,
    PALETTE.bg,
    0.85
  );
  cv.textRight("PEAK", legendX, p.y + 4, PALETTE.fg, scale);
  const rmsW = textWidth("RMS ", scale) + 6;
  cv.rect(
    legendX - peakW - rmsW - 8,
    p.y + 2,
    rmsW + 6,
    lineHeight(scale) + 1,
    PALETTE.bg,
    0.85
  );
  cv.textRight("RMS", legendX - peakW - 8, p.y + 4, PALETTE.accent, scale);
}

function levelPanelHeight(
  opts: ImageOptions,
  panels: number,
  frame: Omit<Frame, "cv">
): number {
  const axis = lineHeight(frame.scale) + 10;
  if (opts.height === undefined) {
    return 56 * frame.scale;
  }
  const free =
    opts.height - frame.headerHeight - axis - frame.margin - panels * PANEL_GAP;
  return Math.max(24 * frame.scale, Math.floor(free / panels));
}

/** Waveform per channel with a dB scale, a level (peak and RMS) panel, time axis, loop markers and clipping in red. */
export function waveformImage(
  r: RenderResult,
  opts: ImageOptions = {}
): PngImage {
  const count = Math.min(MAX_WAVE_PANELS, Math.max(1, r.channels.length));
  const panels = count + 1;
  const probe = newFrame(opts, 1);
  const ph = levelPanelHeight(opts, panels, probe);
  const axis = lineHeight(probe.scale) + 10;
  const height =
    opts.height ??
    probe.headerHeight + panels * (ph + PANEL_GAP) + axis + probe.margin;
  const f = newFrame(opts, height);
  const { cv, scale } = f;
  const plot: Rect = {
    h: 0,
    w: f.width - f.margin * 2 - f.gutter,
    x: f.margin + f.gutter,
    y: f.headerHeight,
  };
  const rects = panelRects(plot.x, plot.w, f.headerHeight, ph, panels);
  const duration = Math.max(r.frames, 1) / r.sampleRate;
  const ticks = timeTicks(duration, plot.w);

  drawHeader(f, opts.title ?? "WAVEFORM", r, "");
  for (const p of rects) {
    drawPanelBox(cv, p);
  }
  drawTimeGrid(cv, ticks, duration, plot, rects);

  const cols = columnStats(r, plot.w - 2);
  const range = waveRange(Math.max(...cols.peak, 1e-9));
  const names = channelNames(r.channels.length);
  const colors = [
    PALETTE.accent,
    PALETTE.pulse,
    PALETTE.triangle,
    PALETTE.wave,
    PALETTE.sid,
    PALETTE.sample,
    PALETTE.fm,
    PALETTE.muted,
  ];
  for (let c = 0; c < count; c += 1) {
    const p = rects[c];
    const color = colors[c % colors.length] ?? PALETTE.accent;
    if (p) {
      drawWaveLabels(cv, p, range, names[c] ?? `CH${c + 1}`, color, scale);
      drawWaveColumns(cv, p, cols, c, range, color);
    }
  }
  const level = rects[count];
  if (level) {
    drawLevelPanel(cv, level, cols, scale);
  }
  if (r.frames === 0) {
    cv.textCenter(
      "NO AUDIO",
      plot.x + plot.w / 2,
      f.headerHeight + ph / 2,
      PALETTE.muted,
      scale
    );
  }
  drawLoopMarkers(cv, r, plot, rects, scale);
  const last = rects.at(-1);
  if (last) {
    drawTimeAxis(cv, ticks, duration, plot, last.y + last.h + 2, scale);
  }
  return cv.toImage();
}

/* ---------- spectrogram ---------- */

const SPECTRO_RANGE_DB = 84;
const MAX_WINDOWS_PER_COLUMN = 6;
const FREQ_MIN = 20;
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000];
const COLOR_STOPS: [number, Rgb][] = [
  [0, [18, 17, 25]],
  [0.2, [43, 35, 88]],
  [0.45, [124, 77, 189]],
  [0.65, [220, 123, 164]],
  [0.85, [243, 178, 74]],
  [1, [255, 243, 207]],
];

let colorLut: Rgb[] | null = null;

function spectrumColor(t: number): Rgb {
  if (!colorLut) {
    colorLut = [];
    for (let i = 0; i < 256; i += 1) {
      colorLut.push(gradientAt(i / 255));
    }
  }
  const i = Math.max(0, Math.min(255, Math.round(t * 255)));
  return colorLut[i] ?? PALETTE.bg;
}

function gradientAt(t: number): Rgb {
  for (let i = 1; i < COLOR_STOPS.length; i += 1) {
    const hi = COLOR_STOPS[i];
    const lo = COLOR_STOPS[i - 1];
    if (hi && lo && t <= hi[0]) {
      const f = (t - lo[0]) / (hi[0] - lo[0]);
      return [
        Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * f),
        Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * f),
        Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * f),
      ];
    }
  }
  return COLOR_STOPS.at(-1)?.[1] ?? PALETTE.fg;
}

/** dBFS spectrum of every pixel column: averages a few windows spread over the column's stretch of audio. */
function spectrumColumns(
  mono: Float32Array,
  size: number,
  width: number
): { db: Float32Array; bins: number } {
  const work = createSpectrumWork(size);
  const { bins } = work;
  const db = new Float32Array(width * bins);
  const mag = new Float64Array(bins);
  const sum = new Float64Array(bins);
  const spc = mono.length / width;
  const windows = Math.max(
    1,
    Math.min(MAX_WINDOWS_PER_COLUMN, Math.floor(spc / size))
  );
  for (let x = 0; x < width; x += 1) {
    sum.fill(0);
    for (let k = 0; k < windows; k += 1) {
      const center = (x + (k + 0.5) / windows) * spc;
      windowedMagSq(work, mono, Math.round(center - size / 2), mag);
      for (let b = 0; b < bins; b += 1) {
        sum[b] = (sum[b] ?? 0) + (mag[b] ?? 0);
      }
    }
    for (let b = 0; b < bins; b += 1) {
      const p = ((sum[b] ?? 0) / windows) * work.ampScale;
      db[x * bins + b] =
        p > 0 ? Math.max(DB_FLOOR, 10 * Math.log10(p)) : DB_FLOOR;
    }
  }
  return { bins, db };
}

/** For each pixel row (top is the highest frequency) the span of FFT bins it covers, on a log frequency axis. */
function rowBins(
  height: number,
  sampleRate: number,
  size: number
): { lo: Float64Array; hi: Float64Array; freq: Float64Array } {
  const fMax = sampleRate / 2;
  const binHz = sampleRate / size;
  const lo = new Float64Array(height);
  const hi = new Float64Array(height);
  const freq = new Float64Array(height);
  const ratio = fMax / FREQ_MIN;
  for (let y = 0; y < height; y += 1) {
    const fHi = FREQ_MIN * ratio ** (1 - y / height);
    const fLo = FREQ_MIN * ratio ** (1 - (y + 1) / height);
    lo[y] = fLo / binHz;
    hi[y] = fHi / binHz;
    freq[y] = Math.sqrt(fLo * fHi);
  }
  return { freq, hi, lo };
}

function rowLevel(
  db: Float32Array,
  base: number,
  bins: number,
  lo: number,
  hi: number
): number {
  if (hi - lo < 1) {
    const pos = (lo + hi) / 2;
    const i = Math.min(bins - 2, Math.floor(pos));
    const f = pos - i;
    return (
      (db[base + i] ?? DB_FLOOR) * (1 - f) + (db[base + i + 1] ?? DB_FLOOR) * f
    );
  }
  let best = DB_FLOOR;
  const from = Math.max(0, Math.floor(lo));
  const to = Math.min(bins - 1, Math.ceil(hi));
  for (let b = from; b <= to; b += 1) {
    best = Math.max(best, db[base + b] ?? DB_FLOOR);
  }
  return best;
}

function freqLabel(hz: number): string {
  if (hz === FREQ_MIN) {
    return `${hz} HZ`;
  }
  return hz >= 1000 ? `${hz / 1000}K` : `${hz}`;
}

function drawFreqAxis(
  cv: Canvas,
  plot: Rect,
  sampleRate: number,
  scale: number
): void {
  const fMax = sampleRate / 2;
  const lh = lineHeight(scale);
  for (const hz of FREQ_TICKS) {
    if (hz >= fMax) {
      continue;
    }
    const y =
      plot.y +
      plot.h * (1 - Math.log(hz / FREQ_MIN) / Math.log(fMax / FREQ_MIN));
    cv.hline(y, plot.x, plot.x + plot.w - 1, PALETTE.fg, 0.14, 2);
    cv.hline(y, plot.x - 4, plot.x - 1, PALETTE.muted);
    cv.textRight(
      freqLabel(hz),
      plot.x - 7,
      Math.round(y - lh / 2 + 1),
      PALETTE.muted,
      scale
    );
  }
}

function drawColorBar(
  cv: Canvas,
  bar: Rect,
  topDb: number,
  scale: number
): void {
  const lh = lineHeight(scale);
  for (let y = 0; y < bar.h; y += 1) {
    cv.rect(bar.x, bar.y + y, bar.w, 1, spectrumColor(1 - y / (bar.h - 1)));
  }
  cv.frame(bar.x - 1, bar.y - 1, bar.w + 2, bar.h + 2, PALETTE.line);
  for (let db = topDb; db >= topDb - SPECTRO_RANGE_DB; db -= DB_STEP) {
    const y = bar.y + ((topDb - db) / SPECTRO_RANGE_DB) * (bar.h - 1);
    cv.hline(y, bar.x + bar.w, bar.x + bar.w + 3, PALETTE.muted);
    cv.text(
      `${db}`,
      bar.x + bar.w + 6,
      Math.round(Math.min(bar.y + bar.h - lh, Math.max(bar.y, y - lh / 2 + 1))),
      PALETTE.muted,
      scale
    );
  }
  cv.text("DB", bar.x - 1, bar.y - lh - 2, PALETTE.accent, scale);
}

function clipColumns(r: RenderResult, width: number): Uint8Array {
  const flags = new Uint8Array(width);
  const spc = r.frames / width;
  for (const plane of r.channels) {
    for (let i = 0; i < r.frames; i += 1) {
      if (Math.abs(plane[i] ?? 0) >= CLIP_LEVEL) {
        flags[Math.min(width - 1, Math.floor(i / spc))] = 1;
      }
    }
  }
  return flags;
}

/** Spectrogram on a log frequency axis (20 Hz to Nyquist) in an 84 dB color scale, with a time axis, loop markers and clipping marks. */
export function spectrogramImage(
  r: RenderResult,
  opts: ImageOptions = {}
): PngImage {
  const probe = newFrame(opts, 1);
  const { scale, margin } = probe;
  const lh = lineHeight(scale);
  const stripH = 8;
  const axis = lh + 10;
  const barW = 14;
  const rightPad = margin + barW + 8 + textWidth("-84", scale) + 6;
  const plotH =
    opts.height === undefined
      ? 176 * scale
      : opts.height - probe.headerHeight - stripH - axis - margin;
  const height =
    opts.height ?? probe.headerHeight + stripH + plotH + axis + margin;
  const f = newFrame(opts, height);
  const { cv } = f;
  const plot: Rect = {
    h: Math.max(32, plotH),
    w: f.width - (margin + f.gutter) - rightPad,
    x: margin + f.gutter,
    y: f.headerHeight + stripH,
  };
  const duration = Math.max(r.frames, 1) / r.sampleRate;
  const size = duration < 2 ? 1024 : 2048;

  drawHeader(f, opts.title ?? "SPECTROGRAM", r, `  FFT ${size}  LOG HZ`);
  cv.rect(plot.x, plot.y, plot.w, plot.h, PALETTE.bg);
  const { db, bins } = spectrumColumns(mixToMono(r), size, plot.w);
  let maxDb = DB_FLOOR;
  for (const v of db) {
    maxDb = Math.max(maxDb, v);
  }
  const topDb = Math.ceil(Math.max(maxDb, -60) / 6) * 6;
  const rows = rowBins(plot.h, r.sampleRate, size);
  for (let x = 0; x < plot.w; x += 1) {
    for (let y = 0; y < plot.h; y += 1) {
      const level = rowLevel(
        db,
        x * bins,
        bins,
        rows.lo[y] ?? 0,
        rows.hi[y] ?? 1
      );
      cv.px(
        plot.x + x,
        plot.y + y,
        spectrumColor((level - (topDb - SPECTRO_RANGE_DB)) / SPECTRO_RANGE_DB)
      );
    }
  }
  cv.frame(plot.x - 1, plot.y - 1, plot.w + 2, plot.h + 2, PALETTE.line);
  drawFreqAxis(cv, plot, r.sampleRate, scale);
  const ticks = timeTicks(duration, plot.w);
  for (const t of ticks) {
    cv.vline(
      plot.x + Math.min(plot.w - 1, (t.value / duration) * plot.w),
      plot.y,
      plot.y + plot.h - 1,
      PALETTE.fg,
      0.12,
      2
    );
  }
  const clips = clipColumns(r, plot.w);
  for (let x = 0; x < plot.w; x += 1) {
    if (clips[x] === 1) {
      cv.rect(plot.x + x, plot.y - stripH + 2, 1, stripH - 3, PALETTE.danger);
    }
  }
  drawColorBar(
    cv,
    { h: plot.h, w: barW, x: plot.x + plot.w + margin, y: plot.y },
    topDb,
    scale
  );
  drawLoopMarkers(cv, r, plot, [plot], scale);
  drawTimeAxis(cv, ticks, duration, plot, plot.y + plot.h + 3, scale);
  return cv.toImage();
}

/* ---------- scopes ---------- */

export interface ScopesOptions extends ImageOptions {
  /** First frame of the stretch to show. Default: where the stems are loudest. */
  frame?: number;
  /** Frames shown per scope. Default 1024. */
  window?: number;
}

const DEFAULT_SCOPE_WINDOW = 1024;
const SILENT_PEAK = 1e-4;
const DUTY_PROBE_SECONDS = 0.12;

interface ScopeSource {
  color: Rgb;
  name: string;
  signal: Float32Array;
}

/** Start of the loudest `window` frames over all sources (searched in steps of half a window). */
function loudestFrame(
  sources: ScopeSource[],
  frames: number,
  window: number
): number {
  const step = Math.max(1, Math.floor(window / 2));
  let best = 0;
  let bestEnergy = -1;
  for (let from = 0; from + window <= Math.max(frames, window); from += step) {
    let energy = 0;
    for (const s of sources) {
      for (let i = from; i < from + window && i < frames; i += 1) {
        const v = s.signal[i] ?? 0;
        energy += v * v;
      }
    }
    if (energy > bestEnergy) {
      bestEnergy = energy;
      best = from;
    }
  }
  return best;
}

/** First rising crossing of the local mean at or after `from` (within one window), so the wave stands still; else `from`. */
function triggerStart(
  signal: Float32Array,
  from: number,
  window: number
): number {
  const span = Math.min(signal.length - from, window * 2);
  if (span <= 2) {
    return from;
  }
  let mean = 0;
  for (let i = 0; i < span; i += 1) {
    mean += signal[from + i] ?? 0;
  }
  mean /= span;
  const limit = Math.min(from + window, signal.length - 1);
  for (let i = from + 1; i < limit; i += 1) {
    if ((signal[i - 1] ?? 0) < mean && (signal[i] ?? 0) >= mean) {
      return i;
    }
  }
  return from;
}

function peakOf(signal: Float32Array, from: number, count: number): number {
  let peak = 0;
  for (let i = from; i < from + count && i < signal.length; i += 1) {
    peak = Math.max(peak, Math.abs(signal[i] ?? 0));
  }
  return peak;
}

/** Text for a scope's right side, longest first, trimmed to what fits. */
function scopeInfo(
  signal: Float32Array,
  start: number,
  window: number,
  sampleRate: number,
  peak: number
): string[] {
  if (peak < SILENT_PEAK) {
    return ["SILENT"];
  }
  const parts: string[] = [`PK ${Math.round(ampToDb(peak) * 10) / 10} DB`];
  const pitch = estimatePitch(signal, start, sampleRate, {
    window: Math.max(2048, window),
  });
  if (pitch.hz !== null) {
    parts.unshift(
      `${pitch.hz.toFixed(1)} HZ ${hzToNoteName(pitch.hz) ?? ""}`.trim()
    );
  }
  const probe = signal.subarray(
    start,
    Math.min(signal.length, start + Math.round(DUTY_PROBE_SECONDS * sampleRate))
  );
  const duty = measureDutyCycle(probe, sampleRate);
  if (duty !== null) {
    parts.splice(1, 0, `DUTY ${Math.round(duty * 100)}%`);
  }
  return parts;
}

function drawScopeTrace(
  cv: Canvas,
  plot: Rect,
  signal: Float32Array,
  start: number,
  window: number,
  range: number,
  color: Rgb
): void {
  const mid = plot.y + plot.h / 2;
  const reach = plot.h / 2 - 2;
  const yOf = (v: number): number =>
    mid - (Math.max(-range, Math.min(range, v)) / range) * reach;
  const perColumn = window / plot.w;
  if (perColumn <= 2) {
    let px = plot.x;
    let py = yOf(signal[start] ?? 0);
    for (let i = 1; i < window; i += 1) {
      const x = plot.x + (i / (window - 1)) * (plot.w - 1);
      const y = yOf(signal[start + i] ?? 0);
      cv.line(px, py, x, y, color, 2);
      px = x;
      py = y;
    }
    return;
  }
  for (let x = 0; x < plot.w; x += 1) {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const end = Math.min(window, Math.ceil((x + 1) * perColumn) + 1);
    for (let i = Math.floor(x * perColumn); i < end; i += 1) {
      const v = signal[start + i] ?? 0;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    cv.rect(plot.x + x, yOf(hi), 1, Math.max(2, yOf(lo) - yOf(hi)), color);
  }
}

function drawScopeCell(
  f: Frame,
  cell: Rect,
  src: ScopeSource,
  from: number,
  window: number,
  sampleRate: number,
  tickMs: number
): void {
  const { cv, scale } = f;
  const lh = lineHeight(scale);
  drawPanelBox(cv, cell);
  const plot: Rect = {
    h: cell.h - lh - 8,
    w: cell.w - 2,
    x: cell.x + 1,
    y: cell.y + lh + 6,
  };
  const start = Math.max(
    0,
    Math.min(
      triggerStart(src.signal, from, window),
      Math.max(0, src.signal.length - window)
    )
  );
  const peak = peakOf(src.signal, start, window);
  const range = waveRange(Math.max(peak, SILENT_PEAK));
  const mid = plot.y + plot.h / 2;
  cv.hline(mid, plot.x, plot.x + plot.w - 1, PALETTE.line);
  cv.hline(plot.y + 1, plot.x, plot.x + plot.w - 1, PALETTE.line, 0.5, 3);
  cv.hline(
    plot.y + plot.h - 2,
    plot.x,
    plot.x + plot.w - 1,
    PALETTE.line,
    0.5,
    3
  );
  const windowMs = (window / sampleRate) * 1000;
  for (let t = tickMs; t < windowMs; t += tickMs) {
    const x = plot.x + (t / windowMs) * plot.w;
    cv.vline(x, plot.y, plot.y + plot.h - 1, PALETTE.line, 0.8);
  }
  drawScopeTrace(
    cv,
    plot,
    src.signal,
    start,
    window,
    range,
    peak < SILENT_PEAK ? PALETTE.muted : src.color
  );
  cv.text(src.name, cell.x + 6, cell.y + 4, src.color, scale);
  let infos = scopeInfo(src.signal, start, window, sampleRate, peak);
  const room = cell.w - 24 - textWidth(`${src.name}  `, scale);
  while (infos.length > 1 && textWidth(infos.join("  "), scale) > room) {
    infos = infos.slice(0, -1);
  }
  cv.textRight(
    infos.join("  "),
    cell.x + cell.w - 6,
    cell.y + 4,
    PALETTE.muted,
    scale
  );
  const edge = `EDGE ${Math.round(ampToDb(range))} DB`;
  cv.rect(
    plot.x + 2,
    plot.y + plot.h - lh - 1,
    textWidth(edge, scale) + 6,
    lh,
    PALETTE.bg,
    0.75
  );
  cv.text(edge, plot.x + 5, plot.y + plot.h - lh + 1, PALETTE.muted, scale);
}

function scopeColumns(count: number): number {
  if (count <= 3) {
    return 1;
  }
  return count <= 12 ? 2 : 3;
}

/** One oscilloscope per channel stem (plus the master mix), each with a rising edge trigger, an auto scaled
    amplitude, pitch, duty cycle and peak readouts. Needs `r.stems` (render with stems: true). */
export function scopesImage(
  r: RenderResult,
  opts: ScopesOptions = {}
): PngImage {
  const { stems } = r;
  if (!stems || stems.length === 0) {
    throw new Error(
      "scopesImage: the render has no stems (render with stems: true)"
    );
  }
  const window = Math.max(
    64,
    Math.min(16_384, Math.round(opts.window ?? DEFAULT_SCOPE_WINDOW))
  );
  const sources: ScopeSource[] = stems.map((signal, i) => {
    const name = (r.stemIds?.[i] ?? `CH${i + 1}`).toUpperCase();
    return { color: colorForChannel(r.stemIds?.[i] ?? "", i), name, signal };
  });
  const from = Math.max(
    0,
    Math.min(
      Math.round(opts.frame ?? loudestFrame(sources, r.frames, window)),
      Math.max(0, r.frames - window)
    )
  );
  const master: ScopeSource = {
    color: PALETTE.fg,
    name: "MASTER",
    signal: mixToMono(r),
  };

  const probe = newFrame(opts, 1);
  const { margin, scale } = probe;
  const cols = scopeColumns(sources.length);
  const rowsCount = Math.ceil(sources.length / cols);
  const cellH =
    opts.height === undefined
      ? 52 * scale
      : Math.max(
          24 * scale,
          Math.floor(
            (opts.height -
              probe.headerHeight -
              margin -
              PANEL_GAP * rowsCount) /
              (rowsCount + 1)
          )
        );
  const height =
    opts.height ??
    probe.headerHeight + (rowsCount + 1) * (cellH + PANEL_GAP) + margin;
  const f = newFrame(opts, height);
  const inner = f.width - margin * 2;
  const windowMs = (window / r.sampleRate) * 1000;
  const tickMs = niceStepMs(windowMs);

  const extra = `  AT ${(from / r.sampleRate).toFixed(3)} S  WINDOW ${windowMs.toFixed(1)} MS  TICK ${tickMs} MS`;
  drawHeader(f, opts.title ?? "SCOPES", r, extra);
  drawScopeCell(
    f,
    { h: cellH, w: inner, x: margin, y: f.headerHeight },
    master,
    from,
    window,
    r.sampleRate,
    tickMs
  );
  const cellW = Math.floor((inner - PANEL_GAP * (cols - 1)) / cols);
  sources.forEach((src, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cell: Rect = {
      h: cellH,
      w: cellW,
      x: margin + col * (cellW + PANEL_GAP),
      y: f.headerHeight + (row + 1) * (cellH + PANEL_GAP),
    };
    drawScopeCell(f, cell, src, from, window, r.sampleRate, tickMs);
  });
  return f.cv.toImage();
}

function niceStepMs(windowMs: number): number {
  return niceStep(windowMs, 8);
}
