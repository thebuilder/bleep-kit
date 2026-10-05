import type { RenderResult } from "../types.ts";
import {
  Canvas,
  cellWidth,
  lineHeight,
  PALETTE,
  type Rgb,
  textWidth,
} from "./canvas.ts";
import { ampToDb, formatDb, formatDuration } from "./format.ts";
import { integratedLufs } from "./loudness.ts";

export interface ImageOptions {
  /** Integer size of the built-in pixel font (1 to 4). Default 2. */
  fontScale?: number;
  /** Image height in pixels; when left out the height follows from the content. */
  height?: number;
  /** Shown top left, for example the sound's name. */
  title?: string;
  /** Image width in pixels. Default 1280. */
  width?: number;
}

export interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}

export interface Frame {
  cv: Canvas;
  /** Space left of every plot for axis labels. */
  gutter: number;
  /** Height used by the two header lines. */
  headerHeight: number;
  margin: number;
  scale: number;
  width: number;
}

const DEFAULT_WIDTH = 1280;

const MIN_TICK_SPACING = 110;

function fontScaleOf(opts: ImageOptions): number {
  return Math.max(1, Math.min(4, Math.round(opts.fontScale ?? 2)));
}

function frameMetrics(opts: ImageOptions): Omit<Frame, "cv"> {
  const scale = fontScaleOf(opts);
  const margin = cellWidth(scale);
  return {
    gutter: cellWidth(scale) * 6 + margin / 2,
    headerHeight: margin + lineHeight(scale) * 2 + scale * 2,
    margin,
    scale,
    width: Math.max(320, Math.round(opts.width ?? DEFAULT_WIDTH)),
  };
}

/** 1, 2 or 5 times a power of ten, the smallest that keeps span / step at or below maxCount. */
export function niceStep(span: number, maxCount: number): number {
  if (!(span > 0)) {
    return 1;
  }
  const raw = span / Math.max(1, maxCount);
  const base = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (base * m >= raw) {
      return base * m;
    }
  }
  return base * 10;
}

export interface Tick {
  label: string;
  value: number;
}

/** Time ticks in seconds, labelled in ms for sounds under a second and in seconds otherwise. */
export function timeTicks(duration: number, plotWidth: number): Tick[] {
  const step = niceStep(
    duration,
    Math.max(2, Math.floor(plotWidth / MIN_TICK_SPACING))
  );
  const ticks: Tick[] = [];
  const inMs = duration < 1;
  const decimals = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
  for (let i = 0; i * step <= duration + step * 1e-6; i += 1) {
    const value = i * step;
    const label = inMs
      ? `${Math.round(value * 1000)} MS`
      : `${value.toFixed(decimals)} S`;
    ticks.push({ label, value });
  }
  return ticks;
}

/** Faint vertical gridlines at each tick across a set of panels. */
export function drawTimeGrid(
  cv: Canvas,
  ticks: Tick[],
  duration: number,
  plot: Rect,
  panels: Rect[]
): void {
  for (const t of ticks) {
    const x = plot.x + (t.value / duration) * plot.w;
    for (const p of panels) {
      cv.vline(
        Math.min(x, plot.x + plot.w - 1),
        p.y + 1,
        p.y + p.h - 2,
        PALETTE.line,
        0.8
      );
    }
  }
}

/** Tick marks and labels under the last panel; labels that would overhang the plot are pushed inside it. */
export function drawTimeAxis(
  cv: Canvas,
  ticks: Tick[],
  duration: number,
  plot: Rect,
  y: number,
  scale: number
): void {
  for (const t of ticks) {
    const x = Math.min(
      plot.x + (t.value / duration) * plot.w,
      plot.x + plot.w - 1
    );
    cv.vline(x, y, y + 3, PALETTE.muted);
    const half = textWidth(t.label, scale) / 2;
    if (x + half > plot.x + plot.w) {
      cv.textRight(t.label, plot.x + plot.w, y + 5, PALETTE.muted, scale);
    } else if (x - half < plot.x) {
      cv.text(t.label, plot.x, y + 5, PALETTE.muted, scale);
    } else {
      cv.textCenter(t.label, x, y + 5, PALETTE.muted, scale);
    }
  }
}

const LOOP_START_COLOR: Rgb = PALETTE.triangle;
const LOOP_END_COLOR: Rgb = PALETTE.sid;

/** Dashed loop start and end lines through the panels, a faint tint between them and a flag on the first panel. */
export function drawLoopMarkers(
  cv: Canvas,
  r: RenderResult,
  plot: Rect,
  panels: Rect[],
  scale: number
): void {
  if (r.loopStart === undefined || r.loopEnd === undefined || r.frames === 0) {
    return;
  }
  const xs = plot.x + (r.loopStart / r.frames) * plot.w;
  const xe = plot.x + (r.loopEnd / r.frames) * plot.w;
  const [first] = panels;
  const last = panels.at(-1);
  if (!(first && last)) {
    return;
  }
  const top = first.y;
  const bottom = last.y + last.h - 1;
  cv.rect(xs, top, Math.max(1, xe - xs), bottom - top, PALETTE.fg, 0.05);
  cv.vline(xs, top, bottom, LOOP_START_COLOR, 1, 4);
  cv.vline(
    Math.min(xe, plot.x + plot.w - 1),
    top,
    bottom,
    LOOP_END_COLOR,
    1,
    4
  );
  const startLabel = `LOOP ${(r.loopStart / r.sampleRate).toFixed(2)} S`;
  const endLabel = `${(r.loopEnd / r.sampleRate).toFixed(2)} S END`;
  cv.text(startLabel, xs + 4, top + 3, LOOP_START_COLOR, scale);
  cv.textRight(
    endLabel,
    Math.min(xe, plot.x + plot.w) - 4,
    top + 3 + lineHeight(scale),
    LOOP_END_COLOR,
    scale
  );
}

/** Peak, RMS and clipping of a render, for the header. */
function headerStats(r: RenderResult): {
  peakDb: number;
  rmsDb: number;
  lufs: number;
  clipFrames: number;
  firstClip: number;
} {
  let peak = 0;
  let sumSq = 0;
  let clipFrames = 0;
  let firstClip = -1;
  for (let i = 0; i < r.frames; i += 1) {
    let frameMax = 0;
    for (const plane of r.channels) {
      const x = plane[i] ?? 0;
      frameMax = Math.max(frameMax, Math.abs(x));
      sumSq += x * x;
    }
    peak = Math.max(peak, frameMax);
    if (frameMax >= 0.999) {
      clipFrames += 1;
      if (firstClip < 0) {
        firstClip = i;
      }
    }
  }
  const count = Math.max(1, r.frames * r.channels.length);
  return {
    clipFrames,
    firstClip,
    lufs: integratedLufs(r.channels, r.frames, r.sampleRate),
    peakDb: ampToDb(peak),
    rmsDb: sumSq > 0 ? 10 * Math.log10(sumSq / count) : -120,
  };
}

/** The two header lines: title with duration, rate and channels, then peak, RMS, LUFS and clipping. */
export function drawHeader(
  f: Frame,
  title: string,
  r: RenderResult,
  extra: string
): void {
  const { cv, margin, scale } = f;
  const lh = lineHeight(scale);
  const s = headerStats(r);
  const left = `${title}  `;
  const used = cv.text(left, margin, margin, PALETTE.accent, scale);
  const info = `${formatDuration(r.frames / r.sampleRate)}  ${r.sampleRate} HZ  ${r.channels.length} CH${extra}`;
  cv.text(info, margin + used + scale * 2, margin, PALETTE.fg, scale);
  const lufs = Number.isFinite(s.lufs) ? s.lufs.toFixed(1) : "-INF";
  const levels = `PEAK ${formatDb(s.peakDb)}  RMS ${formatDb(s.rmsDb)}  LUFS ${lufs}  `;
  const w = cv.text(
    levels.toUpperCase(),
    margin,
    margin + lh + scale,
    PALETTE.muted,
    scale
  );
  const clipText =
    s.clipFrames > 0
      ? `CLIPPED ${s.clipFrames} FRAMES FROM ${(s.firstClip / r.sampleRate).toFixed(3)} S`
      : "NO CLIPPING";
  cv.text(
    clipText,
    margin + w + scale * 2,
    margin + lh + scale,
    s.clipFrames > 0 ? PALETTE.danger : PALETTE.muted,
    scale
  );
}

const KIND_COLORS: [string[], Rgb][] = [
  [["pulse", "square", "sq"], PALETTE.pulse],
  [["tri"], PALETTE.triangle],
  [["noise", "nz"], PALETTE.noise],
  [["wav"], PALETTE.wave],
  [["sid"], PALETTE.sid],
  [["fm", "op"], PALETTE.fm],
  [["sample", "pcm", "dpcm", "smp"], PALETTE.sample],
];

const FALLBACK_COLORS: Rgb[] = [
  PALETTE.pulse,
  PALETTE.triangle,
  PALETTE.wave,
  PALETTE.sid,
  PALETTE.fm,
  PALETTE.sample,
];

/** Color for a channel, picked from its id's kind (pulse1, triangle, noise, wave, sid2, fm3, sample), else by index. */
export function colorForChannel(id: string, index: number): Rgb {
  const name = id.toLowerCase();
  for (const [prefixes, color] of KIND_COLORS) {
    if (prefixes.some((p) => name.startsWith(p))) {
      return color;
    }
  }
  return FALLBACK_COLORS[index % FALLBACK_COLORS.length] ?? PALETTE.pulse;
}

export function newFrame(opts: ImageOptions, height: number): Frame {
  const m = frameMetrics(opts);
  return { ...m, cv: new Canvas(m.width, height) };
}
