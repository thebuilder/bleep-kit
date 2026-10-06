/* The one requestAnimationFrame loop (section 11.4). Once per frame it reads the engine clock, drains the engine
   events that have become audible, reads the master scope, and hands all of it to every registered visual. Under
   reduced motion it runs at 10 fps and visuals draw their still state. */

import { engine } from "../engine/engine.ts";
import type { EngineEvent, SongPosition } from "../lib/contract.ts";
import { reducedMotion } from "../lib/dom.ts";
import { rms } from "./canvas.ts";

/* 1536 frames: the master scope's window and the source of the spectrum (it takes the newest 1024 of them). Far inside
   the 8192 frame scope ring, whose spare frames cover the output latency (the engine writes ahead of what is audible). */
export const MASTER_WINDOW = 1536;

export interface Frame {
  /** seconds since the previous frame (clamped) */
  dt: number;
  events: readonly EngineEvent[];
  /** Engine frame playing out now. */
  frame: number;
  /** master RMS 0..1 and peak */
  level: number;
  /** master left, last MASTER_WINDOW samples (a shared buffer: read it, do not keep it) */
  master: Float32Array<ArrayBufferLike>;
  peak: number;
  playing: boolean;
  position: SongPosition | null;
  reduced: boolean;
  sampleRate: number;
  /** performance.now() in ms */
  time: number;
}

type Visual = (f: Frame) => void;
const visuals = new Set<Visual>();
const ZERO = new Float32Array(MASTER_WINDOW);
let running = false;
let last = 0;
let raf = 0;
let reduced = false;
let lastStill = 0;
let smooth = 0;

/** Register a visual; returns the function that removes it. */
export function addVisual(fn: Visual): () => void {
  visuals.add(fn);
  return () => visuals.delete(fn);
}

function setReduced(on: boolean): void {
  reduced = on;
  document.documentElement.dataset.reduced = on ? "1" : "0";
}

function tick(now: number): void {
  raf = requestAnimationFrame(tick);
  if (reduced && now - lastStill < 100) {
    return;
  }
  lastStill = now;
  const dt = Math.min(0.1, last ? (now - last) / 1000 : 0.016);
  last = now;
  const frame = engine.nowFrame();
  const events = engine.drain();
  const reader = engine.scopes;
  let master: Float32Array<ArrayBufferLike> = ZERO;
  if (reader) {
    try {
      master = reader.at(-1, frame - MASTER_WINDOW, MASTER_WINDOW);
    } catch {
      master = ZERO;
    }
  }
  let peak = 0;
  for (const sample of master) {
    const v = Math.abs(sample);
    if (v > peak) {
      peak = v;
    }
  }
  const level = rms(master);
  smooth = smooth * 0.8 + level * 0.2;
  const f: Frame = {
    dt,
    events,
    frame,
    level: smooth,
    master,
    peak,
    playing: engine.playing,
    position: engine.position,
    reduced,
    sampleRate: engine.sampleRate,
    time: now,
  };
  for (const v of visuals) {
    try {
      v(f);
    } catch (err) {
      console.error("visual failed", err);
    }
  }
}

export function startLoop(): void {
  if (running) {
    return;
  }
  running = true;
  setReduced(reducedMotion());
  if (typeof matchMedia === "function") {
    matchMedia("(prefers-reduced-motion: reduce)").addEventListener(
      "change",
      (e) => setReduced(e.matches)
    );
  }
  raf = requestAnimationFrame(tick);
}

/** Run one frame by hand (tests, and drawing a still frame after a state change under reduced motion). */
export function tickOnce(now = performance.now()): void {
  const was = raf;
  tick(now);
  cancelAnimationFrame(raf);
  raf = was;
}
