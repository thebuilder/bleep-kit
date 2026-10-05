/* The master strip on top of every view: an oscilloscope (trigger on a rising zero crossing, a 2 pixel glow), a 64 bar
   log spectrum with peak hold (hold 400 ms, then fall 24 dB/s, clipping turns the top red), and a level meter. */
import { chipTheme } from "../lib/chips.ts";
import type { ChipId } from "../lib/contract.ts";
import { choose } from "../lib/dom.ts";
import { rgba, surface, triggerIndex } from "./canvas.ts";
import { createSpectrum } from "./fft.ts";
import { addVisual, type Frame, MASTER_WINDOW } from "./loop.ts";

const BARS = 64;
const SEG = 3;
const GAP = 1;
const MIN_HZ = 40;
const MAX_HZ = 16_000;
const DB_FLOOR = -60;
const HOLD_MS = 400;
const FALL_DB_S = 24;
/** The scope normalizes quiet signals up to this height (a fraction of the half height) with at most this gain. */
const SCOPE_TARGET = 0.85;
const SCOPE_MAX_GAIN = 5;

export interface Strip {
  dispose: () => void;
  el: HTMLElement;
  setChip: (chip: ChipId) => void;
}

export function createStrip(host: HTMLElement): Strip {
  host.innerHTML = `<canvas data-k="scope"></canvas><canvas class="sep" data-k="spec"></canvas><canvas class="sep" data-k="meter"></canvas><span class="tag">MASTER</span><span class="clip">CLIP</span>`;
  const q = (k: string) =>
    host.querySelector<HTMLCanvasElement>(
      `canvas[data-k="${k}"]`
    ) as HTMLCanvasElement;
  const scope = surface(q("scope"));
  const spec = surface(q("spec"));
  const meter = surface(q("meter"));
  const clipEl = host.querySelector(".clip") as HTMLElement;
  const fft = createSpectrum(1024);
  const mag = new Float32Array(512);
  const bars = new Float32Array(BARS); // dB
  const peaks = new Float32Array(BARS).fill(DB_FLOOR);
  const peakAt = new Float32Array(BARS);
  const edges = new Int32Array(BARS + 1);
  let theme = chipTheme("nes");
  let lastRate = 0;
  let clipUntil = 0;
  let peakHoldDb = DB_FLOOR;
  let peakHoldAt = 0;
  let scopeGain = 1.6;

  const binEdges = (rate: number) => {
    if (rate === lastRate) {
      return;
    }
    lastRate = rate;
    const hzPerBin = rate / 1024;
    for (let i = 0; i <= BARS; i += 1) {
      const hz = MIN_HZ * (Math.min(MAX_HZ, rate / 2.1) / MIN_HZ) ** (i / BARS);
      edges[i] = Math.max(1, Math.round(hz / hzPerBin));
    }
    for (let i = 1; i <= BARS; i += 1) {
      if ((edges[i] ?? 0) <= (edges[i - 1] ?? 0)) {
        edges[i] = (edges[i - 1] ?? 0) + 1;
      }
    }
  };

  function drawScope(f: Frame): void {
    const { ctx, w, h } = scope;
    ctx.clearRect(0, 0, w, h);
    // faint grid
    ctx.fillStyle = "rgba(125,151,220,0.07)";
    for (let x = 0; x < w; x += 12) {
      ctx.fillRect(x, 0, 1, h);
    }
    ctx.fillRect(0, Math.round(h / 2), w, 1);
    const win = 512;
    const start = f.reduced ? 0 : triggerIndex(f.master, win);
    const pts: number[] = [];
    const amp = h * 0.42;
    // auto gain: quiet music still draws a readable wave; it rises slowly and drops fast so a loud hit never clips
    let wavePeak = 0;
    if (!f.reduced) {
      for (let i = 0; i < win; i += 4) {
        wavePeak = Math.max(
          wavePeak,
          Math.abs(f.master[Math.min(MASTER_WINDOW - 1, start + i)] ?? 0)
        );
      }
    }
    const want = Math.max(
      1.2,
      Math.min(SCOPE_MAX_GAIN, SCOPE_TARGET / Math.max(wavePeak, 1e-4))
    );
    scopeGain =
      want < scopeGain
        ? want
        : scopeGain + (want - scopeGain) * Math.min(1, f.dt * 3);
    for (let i = 0; i < w; i += 2) {
      const idx = Math.min(
        MASTER_WINDOW - 1,
        start + Math.floor((i / w) * win)
      );
      const v = f.reduced ? 0 : (f.master[idx] ?? 0);
      pts.push(h / 2 - Math.max(-1, Math.min(1, v * scopeGain)) * amp);
    }
    const stroke = (width: number, color: string) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = color;
      ctx.beginPath();
      for (const [k, y] of pts.entries()) {
        const x = k * 2;
        if (k === 0) {
          ctx.moveTo(x, Math.round(y));
        } else {
          ctx.lineTo(x, Math.round(y));
        }
      }
      ctx.stroke();
    };
    ctx.lineJoin = "miter";
    stroke(4, rgba(theme.line, 0.16));
    stroke(2, rgba(theme.line, 0.9));
    if (f.reduced) {
      // a flat line with the current level as a small bar on the left
      ctx.fillStyle = theme.line;
      ctx.fillRect(4, h / 2 - f.level * h * 2, 3, Math.max(1, f.level * h * 4));
    }
  }

  function drawSpectrum(f: Frame): void {
    const { ctx, w, h } = spec;
    ctx.clearRect(0, 0, w, h);
    binEdges(f.sampleRate);
    fft.magnitudes(f.master, mag);
    const { dt } = f;
    const slot = w / BARS;
    const barW = Math.max(2, Math.floor(slot) - 1);
    const rows = Math.floor((h - 4) / (SEG + GAP));
    for (let b = 0; b < BARS; b += 1) {
      let m = 0;
      for (let k = edges[b] ?? 1; k < (edges[b + 1] ?? 2); k += 1) {
        m = Math.max(m, mag[k] ?? 0);
      }
      // pink-ish tilt so the highs are visible
      const tilt = 1 + (b / BARS) * 2.2;
      let db = m < 1e-6 ? DB_FLOOR : 20 * Math.log10(m * tilt);
      db = Math.max(DB_FLOOR, Math.min(0, db));
      if (f.reduced) {
        db = DB_FLOOR;
      }
      const cur = bars[b] ?? DB_FLOOR;
      bars[b] = db > cur ? db : Math.max(db, cur - FALL_DB_S * 1.4 * dt);
      if ((bars[b] as number) >= (peaks[b] as number)) {
        peaks[b] = bars[b] as number;
        peakAt[b] = f.time;
      } else if (f.time - (peakAt[b] as number) > HOLD_MS) {
        peaks[b] = Math.max(DB_FLOOR, (peaks[b] as number) - FALL_DB_S * dt);
      }
      const lit = Math.round(
        (((bars[b] as number) - DB_FLOOR) / -DB_FLOOR) * rows
      );
      const peakRow = Math.round(
        (((peaks[b] as number) - DB_FLOOR) / -DB_FLOOR) * rows
      );
      const x = Math.round(b * slot);
      for (let r = 0; r < rows; r += 1) {
        const y = h - 2 - (r + 1) * (SEG + GAP);
        const t = r / rows;
        const on = r < lit;
        if (on) {
          const clip = f.peak >= 0.999 && r >= rows - 3;
          ctx.fillStyle = choose(
            [
              [clip, "#e2766f"],
              [t < 0.5, theme.ramp[0]],
              [t < 0.82, theme.ramp[1]],
            ],
            theme.ramp[2]
          );
          ctx.fillRect(x, y, barW, SEG);
        } else {
          ctx.fillStyle = "rgba(255,255,255,0.035)";
          ctx.fillRect(x, y, barW, SEG);
        }
      }
      if (peakRow > 0 && peakRow >= lit) {
        ctx.fillStyle = "#ece7da";
        ctx.fillRect(x, h - 2 - peakRow * (SEG + GAP), barW, SEG);
      }
    }
  }

  function drawMeter(f: Frame): void {
    const { ctx, w, h } = meter;
    ctx.clearRect(0, 0, w, h);
    const db = f.level < 1e-5 ? -60 : 20 * Math.log10(f.level);
    const frac = Math.max(0, Math.min(1, (db + 48) / 48));
    const rows = Math.floor((h - 8) / (SEG + GAP));
    const lit = Math.round(frac * rows);
    if (f.time > peakHoldAt + HOLD_MS) {
      peakHoldDb = Math.max(-60, peakHoldDb - FALL_DB_S * f.dt);
    }
    if (db >= peakHoldDb) {
      peakHoldDb = db;
      peakHoldAt = f.time;
    }
    const holdRow = Math.round(
      Math.max(0, Math.min(1, (peakHoldDb + 48) / 48)) * rows
    );
    const bw = Math.floor((w - 14) / 2);
    for (const side of [0, 1]) {
      const x = 6 + side * (bw + 2);
      for (let r = 0; r < rows; r += 1) {
        const y = h - 4 - (r + 1) * (SEG + GAP);
        const t = r / rows;
        ctx.fillStyle = choose(
          [
            [r >= lit, "rgba(255,255,255,0.04)"],
            [t > 0.88, "#e2766f"],
            [t > 0.7, "#f3b24a"],
          ],
          "#74c08f"
        );
        ctx.fillRect(x, y, bw, SEG);
      }
      if (holdRow > 0) {
        ctx.fillStyle = "#ece7da";
        ctx.fillRect(x, h - 4 - holdRow * (SEG + GAP), bw, SEG);
      }
    }
    if (f.peak >= 0.999) {
      clipUntil = f.time + 900;
    }
    clipEl.classList.toggle("on", f.time < clipUntil);
  }

  const off = addVisual((f) => {
    drawScope(f);
    drawSpectrum(f);
    drawMeter(f);
  });

  return {
    dispose() {
      off();
      scope.dispose();
      spec.dispose();
      meter.dispose();
    },
    el: host,
    setChip(chip) {
      theme = chipTheme(chip);
    },
  };
}
