/* The audio reactive Pixelkit backdrop: a canvas behind the panels that renders the current chip's scene through the
   ejected Pixelkit renderer at 12 fps, with a mini player (fit to the window, pause when hidden, reduced motion shows
   one settled frame). Engine events become taps and reactive state (section 11.5), rate limited to 8 taps a second. */

import { categoryColor } from "../lib/chips.ts";
import type { ChipId, EngineEvent } from "../lib/contract.ts";
import {
  createRenderer,
  fitView,
  normalizeScene,
  type Renderer,
  register,
  type Scene,
  type TapEvent,
  type View,
} from "../pixelkit/core/index.ts";
import aurora from "../pixelkit/generators/aurora.ts";
import crt from "../pixelkit/generators/crt.ts";
import dust from "../pixelkit/generators/dust.ts";
import embers from "../pixelkit/generators/embers.ts";
import fireflies from "../pixelkit/generators/fireflies.ts";
import glow from "../pixelkit/generators/glow.ts";
import lightning from "../pixelkit/generators/lightning.ts";
import nebula from "../pixelkit/generators/nebula.ts";
import sky from "../pixelkit/generators/sky.ts";
import skyline from "../pixelkit/generators/skyline.ts";
import sparkles from "../pixelkit/generators/sparkles.ts";
import vignette from "../pixelkit/generators/vignette.ts";
import { hexToRgb } from "../visuals/canvas.ts";
import { addVisual, type Frame } from "../visuals/loop.ts";
import { bleepPulse, bleepSea, reactive, resetReactive } from "./reactive.ts";
import { sceneFor } from "./scenes/index.ts";

let registered = false;
function registerAll(): void {
  if (registered) {
    return;
  }
  registered = true;
  for (const g of [
    sky,
    nebula,
    embers,
    lightning,
    fireflies,
    dust,
    glow,
    crt,
    skyline,
    aurora,
    sparkles,
    vignette,
    bleepPulse,
    bleepSea,
  ]) {
    register(g);
  }
}

export interface Backdrop {
  readonly chip: ChipId | null;
  /** Feed engine events (the loop does this by itself; tests call it). */
  handle: (events: readonly EngineEvent[], now: number) => void;
  /** Scene layer types in order, for tests. */
  layerTypes: () => string[];
  setChip: (chip: ChipId) => void;
}

const FPS = 12;
const MAX_TAPS_PER_S = 8;
const BASS_KINDS = new Set([
  "triangle",
  "wave",
  "fm1",
  "fm2",
  "psg1",
  "ch1",
  "voice1",
  "voice3",
]);

export function createBackdrop(canvas: HTMLCanvasElement): Backdrop {
  registerAll();
  const ctx = canvas.getContext("2d");
  let chip: ChipId | null = null;
  let scene: Scene | null = null;
  let renderer: Renderer | null = null;
  let view: View | null = null;
  let img: ImageData | null = null;
  let time = 0;
  let shownAt = -1;
  const taps: TapEvent[] = [];
  const tapTimes: number[] = [];
  let ghost: HTMLCanvasElement | null = null;

  const layerIndex = (type: string) =>
    scene?.layers.findIndex((l) => l.type === type) ?? -1;

  function fit(): void {
    if (!(scene && ctx)) {
      return;
    }
    const next = fitView(
      scene,
      window.innerWidth,
      window.innerHeight,
      window.devicePixelRatio || 1
    );
    if (
      view &&
      next.width === view.width &&
      next.height === view.height &&
      next.pixel === view.pixel
    ) {
      return;
    }
    view = next;
    canvas.width = view.width;
    canvas.height = view.height;
    canvas.style.width = `${view.width * view.pixel}px`;
    canvas.style.height = `${view.height * view.pixel}px`;
    if (renderer) {
      renderer.resize(view.width, view.height);
      img = new ImageData(renderer.pixels, view.width, view.height);
    }
    shownAt = -1;
  }

  function crossfadeFromCurrent(): void {
    if (
      !(canvas.width && canvas.height) ||
      document.documentElement.dataset.reduced === "1"
    ) {
      return;
    }
    ghost?.remove();
    const g = document.createElement("canvas");
    g.width = canvas.width;
    g.height = canvas.height;
    g.getContext("2d")?.drawImage(canvas, 0, 0);
    g.style.cssText = `position:absolute;left:0;top:0;width:${canvas.style.width};height:${canvas.style.height};z-index:0;image-rendering:pixelated;pointer-events:none;opacity:1;transition:opacity 700ms linear`;
    canvas.after(g);
    ghost = g;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        g.style.opacity = "0";
      })
    );
    setTimeout(() => {
      g.remove();
      if (ghost === g) {
        ghost = null;
      }
    }, 800);
  }

  function setChip(next: ChipId): void {
    if (next === chip || !ctx) {
      return;
    }
    const first = chip === null;
    if (!first) {
      crossfadeFromCurrent();
    }
    chip = next;
    scene = normalizeScene(sceneFor(next));
    resetReactive();
    taps.length = 0;
    if (renderer) {
      renderer.setScene(scene);
    } else {
      renderer = createRenderer(scene, {
        height: scene.height,
        width: scene.width,
      });
    }
    view = null;
    fit();
    shownAt = -1;
    paint(true);
  }

  function paint(force = false): void {
    if (!(renderer && img && ctx && scene)) {
      return;
    }
    const reduced = document.documentElement.dataset.reduced === "1";
    const t = reduced ? 60 : Math.floor(time * FPS) / FPS;
    if (!force && t === shownAt) {
      return;
    }
    shownAt = t;
    reactive.t = t;
    renderer.setScene(scene);
    renderer.render(t, { taps: reduced ? [] : taps });
    ctx.putImageData(img, 0, 0);
  }

  function addTap(layer: number, x: number, y: number, now: number): void {
    // x and y are view pixels
    const keep = now - 10_000;
    while (tapTimes.length && (tapTimes[0] ?? 0) < keep) {
      tapTimes.shift();
    }
    const lastSecond = tapTimes.filter((s) => s > now - 1000).length;
    if (lastSecond >= MAX_TAPS_PER_S) {
      return;
    }
    tapTimes.push(now);
    taps.push({ at: time, x, y, ...(layer >= 0 ? { layer } : {}) });
    while (taps.length > 12) {
      taps.shift();
    }
  }

  let seedN = 1;
  function handle(events: readonly EngineEvent[], now: number): void {
    if (!(scene && view)) {
      return;
    }
    for (const e of events) {
      seedN += 1;
      if (e.type === "trigger") {
        const cat = e.channelId || "custom";
        const x = 0.15 + ((seedN * 0.618_033_9) % 0.7);
        if (cat === "explosion" || cat === "hit") {
          reactive.strikes.push({
            at: time,
            big: cat === "explosion",
            seed: seedN * 31 + 7,
            x,
          });
          addTap(
            layerIndex("sky"),
            Math.round(x * view.width),
            Math.round(view.height * 0.2),
            now
          );
          if (reactive.strikes.length > 6) {
            reactive.strikes.shift();
          }
        } else {
          const color = hexToRgb(categoryColor(cat));
          reactive.bursts.push({
            at: time,
            color,
            x,
            y: 0.3 + ((seedN * 0.37) % 0.4),
          });
          if (reactive.bursts.length > 8) {
            reactive.bursts.shift();
          }
          const emb = layerIndex("embers");
          if (emb >= 0) {
            addTap(
              emb,
              Math.round(x * view.width),
              Math.round(view.height * 0.78),
              now
            );
          }
        }
      } else if (e.type === "noteOn") {
        if (BASS_KINDS.has(e.channelId) || e.note < 48) {
          reactive.pulse = Math.min(1, reactive.pulse + 0.7);
        }
      } else if (e.type === "row" && e.row % 4 === 0) {
        reactive.rings.push(time);
        if (reactive.rings.length > 5) {
          reactive.rings.shift();
        }
      }
    }
  }

  addVisual((f: Frame) => {
    const { reduced } = f;
    if (!reduced) {
      time += f.dt;
    }
    reactive.level = f.level;
    reactive.pulse = Math.max(0, reactive.pulse - f.dt * 2.2);
    handle(f.events, f.time);
    paint();
  });
  addEventListener("resize", () => {
    fit();
    paint(true);
  });

  return {
    get chip() {
      return chip;
    },
    handle,
    layerTypes: () => scene?.layers.map((l) => l.type) ?? [],
    setChip,
  };
}
