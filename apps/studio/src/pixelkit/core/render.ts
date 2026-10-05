/* Rendering a scene: renderFrame for one frame, createRenderer for animation (it owns its buffers and reuses them). */
import { drawFrame, LOOP_OPTIONS } from "./renderer.ts";
import { MAX_VIEW } from "./scene.ts";
import type { LoopIssues, Rect, RenderScene, TapEvent } from "./types.ts";

export interface ViewSize {
  height?: number;
  /** View size in pixels, the scene's own size when left out (see fitView for a scene that fills a page). */
  width?: number;
}
export interface FrameOptions {
  /** Keep-out zones in view pixels (text over the scene), for layers with avoid set. */
  keepOut?: readonly Rect[];
  /** Taps so far, oldest first; t and tap.at are on the same clock. Layers see the ones at or before t. */
  taps?: readonly TapEvent[];
}

export interface Renderer {
  readonly height: number;
  /** For each pixel of the last frame, 1 + the index of the layer that last drew it opaquely (0 for none): what a tap hit. */
  readonly hits: Uint8Array;
  /** Layers of the last frame that cannot loop at scene.loop, with the shortest loop length that would work (0 for none). */
  readonly issues: LoopIssues;
  /** RGBA pixels of the last frame, width * height * 4. The same array every frame (until resize), so new ImageData(r.pixels, r.width) can wrap it once. */
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Draw the frame at t seconds (wrapped into the loop when the scene loops) and return its pixels. */
  render(t: number, opts?: FrameOptions): Uint8ClampedArray<ArrayBuffer>;
  /** Change the view size (new pixel and hit arrays). Throws for a side larger than MAX_VIEW. */
  resize(width: number, height: number): void;
  /** The scene it draws. Replace it with setScene. */
  readonly scene: RenderScene;
  /** Draw another scene. A renderer made without a size follows the new scene's size; one given a size keeps it. */
  setScene(scene: RenderScene): void;
  readonly width: number;
}

/** A renderer for animating a scene. */
export function createRenderer(
  scene: RenderScene,
  size: ViewSize = {}
): Renderer {
  let current = checkScene(scene);
  let sized = size.width !== undefined || size.height !== undefined;
  let width = 0;
  let height = 0;
  let pixels = new Uint8ClampedArray(0);
  let own = new Uint8Array(0);
  let hits = new Uint8Array(0);
  const issues: LoopIssues = new Map();
  const resize = (w?: number, h?: number) => {
    width = side(w, current.width);
    height = side(h, current.height);
    pixels = new Uint8ClampedArray(width * height * 4);
    own = new Uint8Array(width * height);
    hits = new Uint8Array(width * height);
  };
  resize(size.width, size.height);
  return {
    get height() {
      return height;
    },
    get hits() {
      return hits;
    },
    issues,
    get pixels() {
      return pixels;
    },
    render(t, opts = {}) {
      if (!Number.isFinite(t)) {
        throw new RangeError(
          `render: t must be a number of seconds, got ${String(t)}.`
        );
      }
      drawFrame(current, pixels, own, t, {
        height,
        hits,
        issues,
        width,
        ...(opts.keepOut ? { keepOut: opts.keepOut } : {}),
        ...(opts.taps ? { events: opts.taps } : {}),
      });
      return pixels;
    },
    resize(w, h) {
      sized = true;
      resize(w, h);
    },
    get scene() {
      return current;
    },
    setScene(s) {
      current = checkScene(s);
      if (
        !sized &&
        (side(undefined, s.width) !== width ||
          side(undefined, s.height) !== height)
      ) {
        resize();
      }
    },
    get width() {
      return width;
    },
  };
}

/** A view side: v, or the scene's own size when v is left out. Not a whole number from 1 to MAX_VIEW throws. */
function side(v: number | undefined, own: number): number {
  const n = v ?? own;
  if (!(Number.isFinite(n) && n >= 1 && n <= MAX_VIEW)) {
    throw new RangeError(
      `A view side must be from 1 to MAX_VIEW (${MAX_VIEW}) pixels, got ${String(n)}.`
    );
  }
  return Math.floor(n);
}
/** The scene, if it has what the renderer needs: a size and a list of layers. Scene JSON goes through normalizeScene first. */
function checkScene(scene: RenderScene): RenderScene {
  const s = scene as Partial<RenderScene> | null;
  if (
    !(
      s &&
      typeof s === "object" &&
      Array.isArray(s.layers) &&
      Number(s.width) >= 1 &&
      Number(s.height) >= 1
    )
  ) {
    throw new TypeError(
      "The renderer needs a scene with a width, a height and layers. For scene JSON, pass it through normalizeScene(json) first: it checks it and fills in what is missing."
    );
  }
  return scene;
}

/** One frame of a scene at t seconds: RGBA pixels, ready for new ImageData(pixels, width). */
export function renderFrame(
  scene: RenderScene,
  t: number,
  opts: ViewSize & FrameOptions = {}
): Uint8ClampedArray<ArrayBuffer> {
  return createRenderer(scene, opts).render(t, opts);
}

/**
 * The shortest loop length (from LOOP_OPTIONS) at which everything in the scene comes back to its start, or 0 when none
 * does (a panning camera never loops, and some motion, like slowly drifting clouds, only fits very long loops). Set it
 * as scene.loop before exporting a seamless animation.
 */
export function loopFor(scene: RenderScene): number {
  for (const loop of LOOP_OPTIONS) {
    const r = createRenderer({ ...scene, loop });
    // two moments, so motion that only some frames ask about is seen too
    r.render(0.5);
    const first = r.issues.size;
    r.render(loop * 0.61);
    if (first === 0 && r.issues.size === 0) {
      return loop;
    }
  }
  return 0;
}
