/* The master strip on top of every view: an oscilloscope (a locked trigger, section 11.4, a 2 pixel glow), a 64 bar
   log spectrum over 40 Hz to 16 kHz on a fixed -72 to 0 dBFS scale (fast attack, a smooth release, a slow peak hold,
   clipping turns the top red), and a level meter. */
import { chipTheme } from "../lib/chips.ts";
import type { ChipId } from "../lib/contract.ts";
import { choose } from "../lib/dom.ts";
import {
  bandEdgesHz,
  bandLevels,
  createBallistics,
  DB_FLOOR,
  dbFraction,
  stepBallistics,
} from "./bands.ts";
import { rgba, surface } from "./canvas.ts";
import { createSpectrum } from "./fft.ts";
import { addVisual, type Frame, MASTER_WINDOW } from "./loop.ts";
import { createTrigger, locate, sampleAt } from "./trigger.ts";

const BARS = 64;
const SEG = 3;
const GAP = 1;
const FFT_SIZE = 1024;
const HOLD_MS = 400;
const FALL_DB_S = 24;
/** About how many frames the master scope shows (a whole number of periods near it when the mix has one). */
const SCOPE_SPAN = 768;
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
  const fft = createSpectrum(FFT_SIZE);
  const mag = new Float32Array(FFT_SIZE / 2);
  const levels = new Float32Array(BARS); // dB, what the bars chase
  const ball = createBallistics(BARS);
  const trigger = createTrigger();
  let edgesHz = bandEdgesHz(BARS, 48_000);
  let lastRate = 0;
  let theme = chipTheme("nes");
  let clipUntil = 0;
  let peakHoldDb = -60;
  let peakHoldAt = 0;
  let scopeGain = 1.6;

  const bands = (rate: number) => {
    if (rate !== lastRate) {
      lastRate = rate;
      edgesHz = bandEdgesHz(BARS, rate);
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
    const amp = h * 0.42;
    const pts: number[] = [];
    let gainPeak = 0;
    if (f.reduced) {
      for (let i = 0; i < w; i += 2) {
        pts.push(h / 2);
      }
    } else {
      const t = locate(trigger, f.master, f.frame - MASTER_WINDOW, {
        sampleRate: f.sampleRate,
        targetSpan: SCOPE_SPAN,
      });
      for (let i = 0; i < t.span; i += 4) {
        gainPeak = Math.max(
          gainPeak,
          Math.abs(
            f.master[Math.min(MASTER_WINDOW - 1, Math.floor(t.start + i))] ?? 0
          )
        );
      }
      // auto gain: quiet music still draws a readable wave; it rises slowly and drops fast so a loud hit never clips
      const want = Math.max(
        1.2,
        Math.min(SCOPE_MAX_GAIN, SCOPE_TARGET / Math.max(gainPeak, 1e-4))
      );
      scopeGain =
        want < scopeGain
          ? want
          : scopeGain + (want - scopeGain) * Math.min(1, f.dt * 1.5);
      for (let i = 0; i < w; i += 2) {
        const v = sampleAt(f.master, t.start + (t.span * i) / w);
        pts.push(h / 2 - Math.max(-1, Math.min(1, v * scopeGain)) * amp);
      }
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
    bands(f.sampleRate);
    if (f.reduced) {
      levels.fill(DB_FLOOR);
      ball.bars.fill(DB_FLOOR);
      ball.peaks.fill(DB_FLOOR);
    } else {
      // the newest FFT_SIZE frames of the window: the oldest ones are the ones the scope ring may not hold yet
      fft.magnitudes(f.master.subarray(f.master.length - FFT_SIZE), mag);
      bandLevels(mag, f.sampleRate, edgesHz, levels);
      stepBallistics(ball, levels, f.dt, f.time);
    }
    const slot = w / BARS;
    const barW = Math.max(2, Math.floor(slot) - 1);
    const rows = Math.floor((h - 4) / (SEG + GAP));
    for (let b = 0; b < BARS; b += 1) {
      const lit = Math.round(dbFraction(ball.bars[b] ?? DB_FLOOR) * rows);
      const peakRow = Math.round(dbFraction(ball.peaks[b] ?? DB_FLOOR) * rows);
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
