/* Pixel-art drawings of rendered audio: a waveform with a played-so-far highlight, and a spectrogram. Both draw in CSS
   pixels onto a Surface and snap everything to chunky pixels. */
import type { RenderResult } from "../lib/contract.ts";
import { rgba, type Surface } from "./canvas.ts";
import { createSpectrum } from "./fft.ts";

export const PX = 3;

export interface WaveOpts {
  /** peak guide lines (clipping) */
  clip?: boolean;
  color: string;
  /** loop points as fractions */
  loop?: [number, number] | null;
  /** 0..1 fraction already played, or a negative number for none */
  played?: number;
}

/** min and max per column of the left channel, as 0..1 magnitudes either side of the middle. */
export function columnPeaks(r: RenderResult, cols: number): Float32Array {
  const out = new Float32Array(cols * 2);
  const [ch] = r.channels;
  if (!ch || r.frames === 0) {
    return out;
  }
  const per = r.frames / cols;
  for (let c = 0; c < cols; c += 1) {
    let lo = 0;
    let hi = 0;
    const from = Math.floor(c * per);
    const to = Math.max(from + 1, Math.floor((c + 1) * per));
    for (let i = from; i < to && i < r.frames; i += 1) {
      const v = ch[i] ?? 0;
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    out[c * 2] = lo;
    out[c * 2 + 1] = hi;
  }
  return out;
}

export function drawWaveform(
  s: Surface,
  r: RenderResult | null,
  o: WaveOpts
): void {
  const { ctx, w, h } = s;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#0e0d14";
  ctx.fillRect(0, 0, w, h);
  const axis = 16;
  const ph = h - axis;
  const mid = Math.floor(ph / 2);
  // grid
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  for (const f of [0.25, 0.75]) {
    for (let x = 0; x < w; x += PX * 2) {
      ctx.fillRect(x, Math.floor(ph * f), PX, 1);
    }
  }
  ctx.fillStyle = rgba(o.color, 0.35);
  ctx.fillRect(0, mid, w, 1);
  if (!r || r.frames === 0) {
    return;
  }
  const cols = Math.max(8, Math.floor(w / PX));
  const pk = columnPeaks(r, cols);
  const played = o.played ?? -1;
  const playedCols = played < 0 ? cols : Math.floor(played * cols);
  const amp = mid - 2;
  for (let c = 0; c < cols; c += 1) {
    const lo = Math.max(-1, pk[c * 2] ?? 0);
    const hi = Math.min(1, pk[c * 2 + 1] ?? 0);
    const top = Math.round(mid - hi * amp);
    const bot = Math.round(mid - lo * amp);
    const x = c * PX;
    const on = c <= playedCols;
    ctx.fillStyle = on ? o.color : rgba(o.color, 0.55);
    ctx.fillRect(x, top, PX - 1, Math.max(2, bot - top));
    ctx.fillStyle = on ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.18)";
    ctx.fillRect(x, top, PX - 1, 1);
    if (o.clip && (hi >= 0.999 || lo <= -0.999)) {
      ctx.fillStyle = "#e2766f";
      ctx.fillRect(x, top, PX - 1, 2);
    }
  }
  // playhead
  if (played >= 0 && played <= 1) {
    const x = Math.min(w - 2, Math.floor(played * cols) * PX);
    ctx.fillStyle = rgba(o.color, 0.18);
    ctx.fillRect(x - PX * 4, 0, PX * 4, ph);
    ctx.fillStyle = "#ece7da";
    ctx.fillRect(x, 0, 2, ph);
  }
  // loop markers
  if (o.loop) {
    for (const [i, f] of o.loop.entries()) {
      ctx.fillStyle = i === 0 ? "#74c08f" : "#b49ae6";
      ctx.fillRect(Math.floor(f * w), 0, 2, ph);
    }
  }
  // time axis
  const dur = r.frames / r.sampleRate;
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  const want = Math.max(2, w / 90);
  const step = steps.find((t) => dur / t <= want) ?? 60;
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = "top";
  for (let t = 0; t <= dur + 1e-6; t += step) {
    const x = Math.floor((t / dur) * (w - 1));
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(x, ph, 1, 4);
    ctx.fillStyle = "#9a95ad";
    const label = step < 1 ? `${t.toFixed(2)}s` : `${Math.round(t)}s`;
    ctx.textAlign = x > w - 40 ? "right" : "left";
    ctx.fillText(label, x + (x > w - 40 ? -2 : 2), ph + 4);
  }
}

/** A spectrogram on a small offscreen canvas (cols by rows, log frequency); the caller scales it up without smoothing. */
export function makeSpectrogram(
  r: RenderResult,
  cols: number,
  rows: number,
  ramp: readonly [string, string, string]
): HTMLCanvasElement | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const [ch] = r.channels;
  if (
    !(ctx && ch) ||
    r.frames === 0 ||
    typeof ctx.createImageData !== "function"
  ) {
    return canvas;
  }
  const size = 1024;
  const spec = createSpectrum(size);
  const win = new Float32Array(size);
  const mag = new Float32Array(size / 2);
  const img = ctx.createImageData(cols, rows);
  const nyq = r.sampleRate / 2;
  const lowHz = 50;
  const stops = ramp.map(
    (c) =>
      [
        Number.parseInt(c.slice(1, 3), 16),
        Number.parseInt(c.slice(3, 5), 16),
        Number.parseInt(c.slice(5, 7), 16),
      ] as const
  );
  const colorAt = (t: number): [number, number, number] => {
    const a = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(a));
    const f = a - i;
    const c0 = stops[i] ?? [0, 0, 0];
    const c1 = stops[i + 1] ?? c0;
    return [
      c0[0] + (c1[0] - c0[0]) * f,
      c0[1] + (c1[1] - c0[1]) * f,
      c0[2] + (c1[2] - c0[2]) * f,
    ];
  };
  for (let c = 0; c < cols; c += 1) {
    const centre = Math.floor(((c + 0.5) / cols) * r.frames);
    const start = Math.max(0, Math.min(r.frames - size, centre - size / 2));
    for (let i = 0; i < size; i += 1) {
      win[i] = ch[start + i] ?? 0;
    }
    spec.magnitudes(win, mag);
    for (let y = 0; y < rows; y += 1) {
      const hz = lowHz * (nyq / lowHz) ** ((rows - 1 - y) / (rows - 1));
      const bin = Math.min(size / 2 - 1, Math.round((hz / nyq) * (size / 2)));
      const m = mag[bin] ?? 0;
      const db = 20 * Math.log10(m + 1e-6);
      const t = Math.max(0, Math.min(1, (db + 84) / 78));
      const [rr, gg, bb] = colorAt(t ** 1.3);
      const k = (y * cols + c) * 4;
      const a = Math.min(1, t * 2.2);
      img.data[k] = rr * a + 14 * (1 - a);
      img.data[k + 1] = gg * a + 13 * (1 - a);
      img.data[k + 2] = bb * a + 20 * (1 - a);
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

export function drawSpectrogram(
  s: Surface,
  spec: HTMLCanvasElement | null,
  played = -1
): void {
  const { ctx, w, h } = s;
  ctx.fillStyle = "#0e0d14";
  ctx.fillRect(0, 0, w, h);
  if (spec) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spec, 0, 0, w, h);
  }
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.font = '10px "JetBrains Mono", monospace';
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const hz of [100, 500, 2000, 8000]) {
    const nyq = 22_050;
    const y = Math.floor(
      h - 1 - (Math.log(hz / 50) / Math.log(nyq / 50)) * (h - 1)
    );
    ctx.fillRect(0, y, 6, 1);
    ctx.fillText(hz >= 1000 ? `${hz / 1000}k` : `${hz}`, 9, y);
  }
  if (played >= 0 && played <= 1) {
    ctx.fillStyle = "#ece7da";
    ctx.fillRect(Math.floor(played * (w - 2)), 0, 2, h);
  }
}
