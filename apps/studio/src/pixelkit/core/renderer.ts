/* The renderer composites a scene's layers into an RGBA buffer. Generators never touch this file; they only see the
   render context described in types.ts (built in context.ts). The public entry points are in render.ts. */

import { BLACK, rgb } from "./color.ts";
import { type Clock, type ContextBase, makeContext } from "./context.ts";
import { styleOf } from "./define.ts";
import { bay, clamp01, frac, mod, mulberry32, TAU } from "./math.ts";
import {
  isPalette,
  PALETTES,
  type PaletteName,
  paletteRGB,
} from "./palettes.ts";
import { GEN } from "./registry.ts";
import { defaults, MAX_VIEW, unknownGenerator } from "./scene.ts";
import type {
  AnyGenerator,
  Color,
  Kind,
  LayerTap,
  LoopIssues,
  Rect,
  RenderContext,
  RenderLayer,
  RenderScene,
  TapEvent,
} from "./types.ts";
import { warnOnce } from "./warn.ts";

/** What the renderer draws one frame with (internal; createRenderer and renderFrame fill it in). */
interface RenderOptions {
  /** Taps, oldest first. Layers see the ones at or before tAbs. */
  events?: readonly TapEvent[];
  height?: number;
  /** Filled with 1 + the index of the layer that last drew each pixel opaquely (0 for none), for hit testing taps. */
  hits?: Uint8Array;
  /** Filled with the layers that cannot loop. */
  issues?: LoopIssues | null;
  /** Keep-out zones in view pixels, for layers with avoid set (the first MAX_KEEP_OUT are used). */
  keepOut?: readonly Rect[];
  /**
   * View size in pixels, at most MAX_VIEW a side; buf, own and hits must hold width * height pixels (the renderer throws
   * otherwise). The scene's own size when left out.
   */
  width?: number;
}

export const KIND_ORDER: readonly Kind[] = [
  "background",
  "foreground",
  "effect",
  "light",
  "post",
];
/** Pixel ownership codes written to the own buffer (read by shadows and rim light). */
export const KIND_CODE: Readonly<Record<Kind, number>> = {
  background: 1,
  effect: 3,
  foreground: 2,
  light: 4,
  post: 5,
};
/** Loop lengths the studio offers; loop issues report the shortest of these that would work. */
export const LOOP_OPTIONS: readonly number[] = [2, 4, 8, 16, 32, 64];
/** Key used in the issues map when camera pan makes a loop impossible. */
export const CAMERA_ISSUE = "camera";
const SNAP_TOL = 0.15;

const PAL_CACHE = new Map<
  string,
  { src: readonly string[] | null | undefined; rgb: Color[] | null }
>();

// With a loop length set, motion must return to its start every loop. A rate is snapped to the nearest whole number of
// cycles per loop only when that changes it by at most `tol` (15% by default); the user's speed always wins. When a
// rate cannot be snapped, the layer is reported with the shortest loop length that would work.
function createClock(Lp: number, tl: number): Clock {
  const fits = (rate: number, len: number, period: number, tol: number) => {
    const n = Math.round((rate * len) / period);
    return (
      n !== 0 && Math.abs((n * period) / len - rate) <= tol * Math.abs(rate)
    );
  };
  const clock: Clock = {
    cyc: (rate, tol = 0.25) => snap(rate, 1, tol),
    flow,
    flow2: (x0, y0, vx, vy, sx, sy, ph = 0) => {
      if (!Lp || (snapOk(vx, sx) && snapOk(vy, sy))) {
        return [flow(x0, vx, sx)[0], flow(y0, vy, sy)[0], 1];
      }
      const u = frac(tl / Lp + ph);
      return [
        mod(x0 + vx * Lp * (u - 0.5), sx),
        mod(y0 + vy * Lp * (u - 0.5), sy),
        fade(u),
      ];
    },
    issue: null,
    lm: (fn) => {
      if (!Lp) {
        return fn(tl);
      }
      const a = tl / Lp;
      return fn(tl) * (1 - a) + fn(tl - Lp) * a;
    },
    v: (speed, span, tol) => snap(speed, span, tol),
    // Oscillations (sway, twinkle, flicker) tolerate more change than travel speeds before they count as wrong.
    w: (rate, tol = 0.35) => snap(rate, TAU, tol),
  };
  function snap(rate: number, period: number, tol = SNAP_TOL): number {
    if (!(Lp && rate)) {
      return rate;
    }
    if (fits(rate, Lp, period, tol)) {
      return (Math.round((rate * Lp) / period) * period) / Lp;
    }
    const need = LOOP_OPTIONS.find((len) => fits(rate, len, period, tol)) ?? 0;
    const { issue } = clock;
    if (!issue) {
      clock.issue = { need };
    } else if (issue.need && (!need || need > issue.need)) {
      issue.need = need;
    }
    return rate;
  }
  // Particles keep their true speed. If a lap does not fit the loop, each particle travels for one loop and fades out
  // and back in at its start (phase ph staggers them).
  function snapOk(vel: number, span: number): boolean {
    return !(Lp && vel) || fits(vel, Lp, span, SNAP_TOL);
  }
  function fade(u: number): number {
    if (u < 0.15) {
      return u / 0.15;
    }
    return u > 0.85 ? (1 - u) / 0.15 : 1;
  }
  function flow(
    p0: number,
    vel: number,
    span: number,
    ph = 0
  ): [number, number] {
    if (!(Lp && vel)) {
      return [mod(p0 + vel * tl, span), 1];
    }
    if (snapOk(vel, span)) {
      return [
        mod(p0 + ((Math.round((vel * Lp) / span) * span) / Lp) * tl, span),
        1,
      ];
    }
    const u = frac(tl / Lp + ph);
    return [mod(p0 + vel * Lp * (u - 0.5), span), fade(u)];
  }
  return clock;
}

/** Keep-out zones rasterized for one frame. */
interface Keep {
  /** Per view column, the row below the lowest zone covering it (0 when none does). */
  col: Int16Array;
  /** Identifies the zones, for the static cache key. */
  key: string;
  /** 1 inside a zone. */
  mask: Uint8Array;
  /** The lowest of those rows. */
  row: number;
}
function rasterizeKeep(rects: readonly Rect[], W: number, H: number): Keep {
  const mask = new Uint8Array(W * H);
  const col = new Int16Array(W);
  for (const r of rects) {
    const x0 = Math.max(0, Math.floor(r.x));
    const x1 = Math.min(W, Math.ceil(r.x + r.w));
    const y0 = Math.max(0, Math.floor(r.y));
    const y1 = Math.min(H, Math.ceil(r.y + r.h));
    for (let x = x0; x < x1; x++) {
      if (y1 > at(col, x)) {
        col[x] = y1;
      }
      for (let y = y0; y < y1; y++) {
        mask[y * W + x] = 1;
      }
    }
  }
  return {
    col,
    key: rects.map((r) => `${r.x},${r.y},${r.w},${r.h}`).join(";"),
    mask,
    row: Math.max(0, ...col),
  };
}

/** Everything one frame's layers share. */
interface Frame {
  buf: Uint8ClampedArray;
  camX: number;
  clock: Clock;
  events: readonly TapEvent[];
  H: number;
  hits: Uint8Array | null;
  keep: Keep | null;
  L: number;
  own: Uint8Array;
  sceneH: number;
  /** The scene's own size. */
  sceneW: number;
  /** Ground published so far, per view column. */
  surf: Int16Array;
  t: number;
  tAbs: number;
  /** View size. */
  W: number;
  /** 1 where a wet layer drew last. */
  wet: Uint8Array;
}
let WET = new Uint8Array(0);
/** Keep-out rectangles beyond this many are ignored. */
export const MAX_KEEP_OUT = 64;
const NO_TAPS: readonly LayerTap[] = Object.freeze([]);

/**
 * Draw one frame into buf (RGBA, width*height*4) and own (one ownership code per pixel), at t seconds (wrapped into the
 * loop when scene.loop is set; the camera pans with the unwrapped time). issues is filled with layer => { need } for
 * layers whose motion cannot loop at scene.loop: need is the shortest loop length from LOOP_OPTIONS that works, or 0 if
 * none does, and CAMERA_ISSUE => { need: 0 } when camera pan is on with a loop.
 * Opacity applies to every draw call, so a layer's own overlapping strokes build up the same way whether or not it is cached.
 */
export function drawFrame(
  scene: RenderScene,
  buf: Uint8ClampedArray,
  own: Uint8Array,
  t: number,
  o: RenderOptions
): void {
  const issues = o.issues ?? null;
  const frame = startFrame(scene, buf, own, t, t, o);
  issues?.clear();
  if (issues && frame.L && Number(scene.camera?.speed)) {
    issues.set(CAMERA_ISSUE, { need: 0 });
  }
  for (const [index, L] of scene.layers.entries()) {
    const g = Object.hasOwn(GEN, L.type) ? GEN[L.type] : undefined;
    if (!g) {
      throw unknownGenerator(L.type);
    }
    if (L.visible !== false && shown(L, frame.W)) {
      const issue = drawNamed(frame, L, g, index);
      if (issues && issue) {
        issues.set(L, issue);
      }
    }
  }
  postProcess(scene, buf, frame.W, frame.H);
}
/** Clear the buffers and set up what every layer of this frame shares. */
function startFrame(
  scene: RenderScene,
  buf: Uint8ClampedArray,
  own: Uint8Array,
  tLoop: number,
  tAbs: number,
  o: RenderOptions
): Frame {
  const W = viewSide(o.width, scene.width);
  const H = viewSide(o.height, scene.height);
  const short = [
    buf.length < W * H * 4 && "buf",
    own.length < W * H && "own",
    o.hits && o.hits.length < W * H && "hits",
  ].filter(Boolean);
  if (short.length) {
    throw new RangeError(
      `render: ${short.join(", ")} too small for a ${W} x ${H} view.`
    );
  }
  const Lp = scene.loop && scene.loop > 0 ? scene.loop : 0;
  buf.fill(0);
  own.fill(0);
  o.hits?.fill(0);
  if (WET.length < W * H) {
    WET = new Uint8Array(W * H);
  }
  const wet = WET.subarray(0, W * H);
  wet.fill(0);
  const tl = Lp ? wrapTime(tLoop, Lp) : tLoop;
  const camSpeed = Number(scene.camera?.speed) || 0;
  return {
    buf,
    camX: (Number(scene.camera?.x) || 0) + camSpeed * tAbs,
    clock: createClock(Lp, tl),
    events: o.events ?? [],
    H,
    hits: o.hits ?? null,
    keep: o.keepOut?.length
      ? rasterizeKeep(o.keepOut.slice(0, MAX_KEEP_OUT), W, H)
      : null,
    L: Lp,
    own,
    sceneH: Math.max(1, scene.height),
    sceneW: Math.max(1, scene.width),
    surf: new Int16Array(W).fill(H),
    t: tl,
    tAbs,
    W,
    wet,
  };
}
/**
 * Time wrapped into a loop of length L. A time already inside the loop is used as it is; one outside is wrapped and
 * snapped to a nanosecond grid, so t and t + L give exactly the same frame instead of differing in the last digits.
 */
function wrapTime(t: number, L: number): number {
  if (t >= 0 && t < L) {
    return t;
  }
  const r = Math.round((t - Math.floor(t / L) * L) * 1e9) / 1e9;
  return r >= L ? 0 : r;
}
/** A view side: the given size when it is a sensible number, the scene's otherwise. Larger than MAX_VIEW throws. */
function viewSide(v: number | undefined, own: number): number {
  if (v === undefined || !Number.isFinite(v) || v < 1) {
    return own;
  }
  if (v > MAX_VIEW) {
    throw new RangeError(
      `render: a view side of ${v} is larger than MAX_VIEW (${MAX_VIEW}).`
    );
  }
  return Math.floor(v);
}
/** The layer's show range includes the view width. */
function shown(L: RenderLayer, W: number): boolean {
  const s = L.show;
  return !s || ((s.minWidth ?? 0) <= W && W <= (s.maxWidth ?? MAX_VIEW));
}

/** Where a layer draws in the view. */
interface Placement {
  avoid: boolean;
  /** c.left of the first strip. */
  base: number;
  /** Shift from layer to view pixels. */
  dx: number;
  dy: number;
  h: number;
  /** Scene-width strips an extending layer draws; 1 otherwise. */
  strips: number;
  /** The layer's W and H. */
  w: number;
}
function placement(f: Frame, L: RenderLayer, g: AnyGenerator): Placement {
  const base = Math.round(
    f.camX * (typeof L.parallax === "number" ? L.parallax : (g.parallax ?? 1))
  );
  const screen = !!g.filter || g.fit === "screen";
  const fx = screen
    ? "stretch"
    : (L.fit?.x ?? (g.fit === "extend" ? "extend" : "stretch"));
  const fy = screen ? "stretch" : (L.fit?.y ?? "stretch");
  const extraX = f.W - f.sceneW;
  const extraY = f.H - f.sceneH;
  let dx = 0;
  if (fx === "center") {
    dx = Math.round(extraX / 2);
  } else if (fx === "right") {
    dx = extraX;
  }
  let dy = 0;
  if (fy === "center") {
    dy = Math.round(extraY / 2);
  } else if (fy === "bottom") {
    dy = extraY;
  }
  return {
    avoid: !!L.avoid && !!f.keep,
    base,
    dx,
    dy,
    h: fy === "stretch" ? f.H : f.sceneH,
    strips: fx === "extend" ? Math.max(1, Math.ceil(f.W / f.sceneW)) : 1,
    w: fx === "stretch" ? f.W : f.sceneW,
  };
}
/** Maps world (X, Y) of strip k to a view pixel index, or -1 when it is outside the strip, the view or a keep-out zone. */
function locator(
  f: Frame,
  pl: Placement,
  k: number
): (X: number, Y: number) => number {
  const { W, H } = f;
  const lo = pl.strips > 1 ? k * pl.w : 0;
  const hi = pl.strips > 1 ? Math.min(W, lo + pl.w) : W;
  const mask = pl.avoid ? f.keep?.mask : undefined;
  const shift = pl.dx - pl.base;
  return (X, Y) => {
    const x = Math.floor(X) + shift;
    const y = Math.floor(Y) + pl.dy;
    if (x < lo || x >= hi || y < 0 || y >= H) {
      return -1;
    }
    const j = y * W + x;
    return mask?.[j] ? -1 : j;
  };
}
/** Strip k gets its own random stream so screen-filling particles differ between strips; the first keeps the layer's. */
const stripRng = (seed: number, k: number) =>
  mulberry32(k === 0 ? seed : (seed ^ Math.imul(k, 0x9e_37_79_b1)) | 0);

/** Where one layer's drawing goes: its ownership code, the top edge of solid pixels, and the ground it publishes. */
interface LayerOutput {
  code: number;
  /** c.setGround() was called: publish gtop instead of top. */
  explicit: boolean;
  /** Ground published with c.setGround(). */
  gtop: Int16Array;
  /** 1 + its index in the scene, for the hit buffer. */
  hit: number;
  /** Top edge of opaque pixels per column, for solid layers. */
  top: Int16Array | null;
  /** Its opaque pixels count as water. */
  wet: boolean;
}

/** drawLayer, with an error from the generator saying which layer it came from. */
function drawNamed(
  f: Frame,
  L: RenderLayer,
  g: AnyGenerator,
  index: number
): { need: number } | null {
  try {
    return drawLayer(f, L, g, index);
  } catch (e) {
    const name = L.name ? `"${L.name}" ` : "";
    throw new Error(
      `Layer ${index + 1} ${name}(generator "${g.id}") failed to draw: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e }
    );
  }
}
/** Draw one layer (live or from its cache), publish its ground, and return its loop issue. */
function drawLayer(
  f: Frame,
  L: RenderLayer,
  g: AnyGenerator,
  index: number
): { need: number } | null {
  const { H, surf, clock } = f;
  clock.issue = null;
  const op = clamp01(typeof L.opacity === "number" ? L.opacity : 1);
  const addB = (L.blend ?? g.blend) === "add";
  const stored = Object.assign(defaults(L.type), L.params);
  const p = renderValues(g, stored);
  const out = layerOutput(f, g, p, addB, index);
  const pl = placement(f, L, g);
  const setup: LayerSetup = {
    addB,
    f,
    L,
    op,
    out,
    p,
    pl,
    style: g.styles ? styleOf(g, stored) : undefined,
    taps: layerTaps(f, pl, index),
  };
  // watch whether the live drawing asks for the time (or the frame): a layer that does not is cached from the next frame
  let moved = false;
  const touch = () => {
    moved = true;
  };
  const bases: ContextBase[] = Array.from({ length: pl.strips }, (_, k) => ({
    ...layerBase(setup, k),
    touch,
  }));
  // Cache only what the cache reproduces exactly: normal blend at full opacity, not a filter (it reads the frame), and
  // not a generator that draws from something besides c.
  const cacheable = !(addB || g.filter || g.live) && op === 1;
  const mk = movesKey(L, stored, g);
  const ent = cacheable ? cachedLayer(L, g, stored, bases, f, pl, mk) : null;
  clock.issue = null; // only the live drawing counts: a cache holds what never moves, which raises no loop issues
  paint(g, bases, ent, f, out);
  if (cacheable && !ent?.still) {
    judge(L, mk, moved);
  }
  publishGround(out, surf, H);
  return clock.issue;
}
/** Where a layer's drawing is recorded: what it owns, its solid top edge, whether it is water, what a tap hits. */
function layerOutput(
  f: Frame,
  g: AnyGenerator,
  p: Record<string, unknown>,
  addB: boolean,
  index: number
): LayerOutput {
  const { W, H } = f;
  const solid = !addB && !!g.solid && (g.solid === true || !!g.solid(p));
  const scenery = g.kind === "background" || g.kind === "foreground";
  return {
    code: !(g.filter || addB) && scenery ? KIND_CODE[g.kind] : 0,
    explicit: false,
    gtop: new Int16Array(W).fill(H),
    hit: index + 1,
    top: solid ? new Int16Array(W).fill(H) : null,
    wet: !!g.wet && !addB,
  };
}
/** Record whether a layer's live drawing asked for the time, keeping what is known about its renderStatic. */
function judge(L: RenderLayer, mk: string, moved: boolean): void {
  const prev = VERDICT.get(L);
  VERDICT.set(L, {
    fixedMoves: prev?.key === mk && prev.fixedMoves,
    key: mk,
    moves: moved,
  });
}
/**
 * Draw a layer's strips: from its cache, plus render when the layer moves; or all of it live. renderStatic and render
 * each get a fresh random stream, live or cached, so render draws the same whether the static part came from the cache.
 */
function paint(
  g: AnyGenerator,
  bases: readonly ContextBase[],
  ent: CacheEntry | null,
  f: Frame,
  out: LayerOutput
): void {
  if (ent) {
    composite(ent, f, out);
  }
  for (const [k, base] of bases.entries()) {
    if (!ent && g.renderStatic) {
      g.renderStatic(makeContext({ ...base, rng: stripRng(base.seed, k) }));
    }
    if (!ent?.still) {
      g.render(makeContext(base));
    }
  }
}
/** The params as render sees them: colors as [r, g, b] (rgb caches them, so this costs a map lookup per color). */
function renderValues(
  g: AnyGenerator,
  stored: Record<string, unknown>
): Record<string, unknown> {
  const p = { ...stored };
  for (const [k, spec] of Object.entries(g.params)) {
    if (spec.type === "color") {
      p[k] = rgb(stored[k]);
    }
  }
  return p;
}
/** The taps a layer sees: those at or before this frame, in its own coordinates. */
function layerTaps(
  f: Frame,
  pl: Placement,
  index: number
): readonly LayerTap[] {
  if (!f.events.length) {
    return NO_TAPS;
  }
  return f.events
    .filter((e) => e.at <= f.tAbs)
    .map((e) => ({
      age: f.tAbs - e.at,
      hit: e.layer === index,
      x: Math.floor(e.x) + pl.base - pl.dx,
      y: Math.floor(e.y) - pl.dy,
    }));
}

/** What every strip of one layer shares. */
interface LayerSetup {
  addB: boolean;
  f: Frame;
  L: RenderLayer;
  op: number;
  out: LayerOutput;
  /** The params as render sees them. */
  p: Record<string, unknown>;
  pl: Placement;
  style: unknown;
  taps: readonly LayerTap[];
}
/** The primitives strip k of a layer draws through; makeContext builds the render context from them. */
function layerBase(setup: LayerSetup, k: number): ContextBase {
  const { f, L, p, style, op, addB, out, pl, taps } = setup;
  const { W, H, buf, surf, clock, keep } = f;
  const loc = locator(f, pl, k);
  const viewX = (X: number) =>
    Math.min(W - 1, Math.max(0, Math.floor(X) - pl.base + pl.dx));
  const seed = seedOf(L);
  return {
    buf,
    clearance(X) {
      if (!(pl.avoid && keep)) {
        return 0;
      }
      const row = X === undefined ? keep.row : at(keep.col, viewX(X));
      return row ? Math.max(0, row - pl.dy) : 0;
    },
    clock,
    glow(X, Y, col, a0 = 1) {
      const j = loc(X, Y);
      const a = a0 * op;
      if (j >= 0 && a > 0) {
        addAt(buf, j * 4, col, a);
      }
    },
    groundY: (X) => at(surf, viewX(X)) - pl.dy,
    H: pl.h,
    isWater(X, Y) {
      const x = Math.floor(X) - pl.base + pl.dx;
      const y = Math.floor(Y) + pl.dy;
      return x >= 0 && y >= 0 && x < W && y < H && f.wet[y * W + x] === 1;
    },
    left: pl.base + k * pl.w,
    loop: f.L,
    opacity: op,
    own: f.own,
    p,
    plot(X, Y, col, a0 = 1) {
      const j = loc(X, Y);
      const a = a0 * op;
      if (j < 0 || a <= 0) {
        return;
      }
      if (addB) {
        addAt(buf, j * 4, col, a);
        return;
      }
      blendAt(buf, j * 4, col[0], col[1], col[2], a);
      if (a >= 0.5) {
        mark(f, out, j);
      }
    },
    rng: stripRng(seed, k),
    scene: { h: f.sceneH, w: f.sceneW },
    seed,
    setGround(X, Y) {
      out.explicit = true;
      lower(out.gtop, Math.floor(X) - pl.base + pl.dx, Y + pl.dy);
    },
    style,
    t: f.t,
    taps,
    touch: () => undefined,
    view: { h: H, left: pl.base - pl.dx, w: W },
    W: pl.w,
  };
}

/** Later layers stand on what this layer published: its c.setGround() line, or the top of its solid pixels. */
function publishGround(out: LayerOutput, surf: Int16Array, H: number): void {
  const pub = out.explicit ? out.gtop : out.top;
  for (let x = 0; pub && x < surf.length; x++) {
    if (at(pub, x) < H) {
      surf[x] = at(pub, x);
    }
  }
}

/** A slot of a typed array the caller has bounds-checked (0 otherwise, which never happens). */
const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
/** Normal blend of one pixel toward (r, g, b) by a, exactly like buf[i] += (r - buf[i]) * a per channel. */
function blendAt(
  buf: Uint8ClampedArray,
  i: number,
  r: number,
  g: number,
  b: number,
  a: number
): void {
  const r0 = buf[i] as number;
  const g0 = buf[i + 1] as number;
  const b0 = buf[i + 2] as number;
  buf[i] = r0 + (r - r0) * a;
  buf[i + 1] = g0 + (g - g0) * a;
  buf[i + 2] = b0 + (b - b0) * a;
}

/** Integer seed of a layer (0 when missing). */
const seedOf = (L: RenderLayer): number => (L.seed ?? 0) | 0;

function addAt(buf: Uint8ClampedArray, i: number, col: Color, a: number): void {
  buf[i] = (buf[i] as number) + col[0] * a;
  buf[i + 1] = (buf[i + 1] as number) + col[1] * a;
  buf[i + 2] = (buf[i + 2] as number) + col[2] * a;
}
/** Record ownership, the solid top edge, water and the hit layer for an opaque pixel j. */
function mark(f: Frame, out: LayerOutput, j: number): void {
  const x = j % f.W;
  if (out.code) {
    f.own[j] = out.code;
  }
  if (out.top) {
    const y = (j - x) / f.W;
    if (y < at(out.top, x)) {
      out.top[x] = y;
    }
  }
  f.wet[j] = out.wet ? 1 : 0;
  if (f.hits) {
    f.hits[j] = out.hit;
  }
}
/** Raise the ground at view column x to y, if y is higher. */
function lower(ground: Int16Array, x: number, Y: number): void {
  if (x < 0 || x >= ground.length) {
    return;
  }
  const y = Math.max(0, Math.floor(Y));
  if (y < at(ground, x)) {
    ground[x] = y;
  }
}

interface CacheEntry {
  /** Coverage of the cached pixels. */
  a: Float32Array;
  /** Additive light the cached part adds. */
  addc: Float32Array;
  /** Straight (not premultiplied) color of the cached normal-blend pixels. */
  col: Float32Array;
  /** The pixels the cached part covers, and the pixels it lights, so compositing skips the empty rest of the view. */
  cover: Int32Array;
  explicit: boolean;
  /** renderStatic asked for the time or read the frame, so nothing of the layer can be cached. */
  fixedMoves: boolean;
  gen: AnyGenerator | null;
  /** Ground published with c.setGround() by the cached part. */
  gr: Int16Array;
  H: number;
  keyBase: string;
  lit: Int32Array;
  off: number;
  /** The camera is moving: drawing live is cheaper than a cache that misses every frame. */
  panning: boolean;
  /** Pixels a single plot covered at least half: they mark ownership, ground, water and hits, as a live plot would. */
  solid: Uint8Array;
  /** render never asked for the time: the cache holds the whole layer. Otherwise it holds renderStatic's part. */
  still: boolean;
  /** View size the arrays are for. */
  W: number;
}
/*
 * Cached output of static layers, keyed by the layer object itself, so layers need no id and deleted layers are garbage
 * collected. Each layer keeps an entry for each of the last few view sizes it was drawn at, so a preview and an export
 * of the same scene do not keep rebuilding each other's cache.
 */
let CACHE = new WeakMap<RenderLayer, CacheEntry[]>();
const VIEWS_PER_LAYER = 3;
/** Drop every cached static layer (after replacing generators or loading a new scene). */
export function clearStaticCache(): void {
  CACHE = new WeakMap();
}

/**
 * The cache entry to draw from, rebuilt when its key changed. null to draw live: the first time a layer is drawn with
 * these params (to see whether it moves), when it moves and has no renderStatic, and while the camera pans.
 */
function cachedLayer(
  L: RenderLayer,
  g: AnyGenerator,
  stored: Record<string, unknown>,
  bases: readonly ContextBase[],
  f: Frame,
  pl: Placement,
  mk: string
): CacheEntry | null {
  const verdict = VERDICT.get(L);
  if (verdict?.key !== mk || verdict.fixedMoves) {
    return null;
  }
  if (verdict.moves && !g.renderStatic) {
    CACHE.delete(L); // nothing of it can be cached: free the arrays
    return null;
  }
  const keyBase = `${JSON.stringify([L.type, stored, seedOf(L), f.W, f.H, f.sceneW, f.sceneH, f.L, pl.w, pl.h, pl.dx, pl.dy, pl.strips, pl.avoid ? f.keep?.key : "", g.version ?? 0])}|${f.surf.join(",")}`;
  const entries = CACHE.get(L) ?? [];
  const ent = entries.find((e) => e.W === f.W && e.H === f.H);
  const valid = ent?.gen === g && ent.keyBase === keyBase;
  if (ent && valid) {
    const use = reuse(ent, pl, verdict.moves);
    if (use !== "rebuild") {
      return use;
    }
  }
  const built = buildCache(ent, f, pl, bases, keyBase, g, !verdict.moves);
  if (built.fixedMoves || !(built.still || g.renderStatic)) {
    if (built.fixedMoves) {
      warnOnce(
        `${g.id}: renderStatic asked for the time or read the frame, so it cannot be cached and the layer is drawn live every frame. Move that part to render.`
      );
    }
    // otherwise render asked for the time after all (only at some moments): either way, draw it live from now on
    VERDICT.set(L, { fixedMoves: built.fixedMoves, key: mk, moves: true });
    CACHE.delete(L);
    return null;
  }
  CACHE.set(L, [
    built,
    ...entries.filter((e) => e !== built).slice(0, VIEWS_PER_LAYER - 1),
  ]);
  return built;
}
/** What to do with a cache entry whose key still matches: use it, draw live (the camera moved it), or rebuild it. */
function reuse(
  ent: CacheEntry,
  pl: Placement,
  moves: boolean
): CacheEntry | null | "rebuild" {
  if (ent.off !== pl.base) {
    ent.off = pl.base;
    // a cache would miss every frame. A slow layer keeps its place for a few frames between steps; rebuilding then
    // costs about one live draw and is reused until the next step, so it is never worse than drawing live
    ent.panning = true;
    return null;
  }
  return ent.panning || ent.still === moves ? "rebuild" : ent;
}
/**
 * Whether a layer's live drawing asked for the time, with the generator and params it was drawn with: one that did
 * moves and is drawn every frame, one that did not is cached whole.
 */
const VERDICT = new WeakMap<
  RenderLayer,
  { key: string; moves: boolean; fixedMoves: boolean }
>();
/** A number per generator object, so a generator replaced under the same id (an edited module) is looked at afresh. */
const GEN_IDS = new WeakMap<AnyGenerator, number>();
let genCount = 0;
const genId = (g: AnyGenerator): number => {
  const known = GEN_IDS.get(g);
  if (known !== undefined) {
    return known;
  }
  genCount += 1;
  GEN_IDS.set(g, genCount);
  return genCount;
};
const movesKey = (L: RenderLayer, stored: object, g: AnyGenerator) =>
  `${L.type}|${genId(g)}|${g.version ?? 0}|${JSON.stringify(stored)}`;

/** List the pixels a cache entry covers and lights. */
function indexCache(E: CacheEntry): void {
  const { a, addc } = E;
  const cover: number[] = [];
  const lit: number[] = [];
  for (let j = 0; j < a.length; j++) {
    if ((a[j] as number) > 0) {
      cover.push(j);
    }
    const k = j * 3;
    if (addc[k] || addc[k + 1] || addc[k + 2]) {
      lit.push(j);
    }
  }
  E.cover = Int32Array.from(cover);
  E.lit = Int32Array.from(lit);
}
/**
 * Over-blend the cached pixels, then add the cached light on top (light a later plot covered was already taken out), as
 * the live calls would have, up to rounding. Only the pixels
 * the cache covers are visited (compositing every pixel of the view for every cached layer was most of a frame).
 */
function composite(ent: CacheEntry, f: Frame, out: LayerOutput): void {
  const { buf, W } = f;
  const { a, col, addc, cover, lit } = ent;
  for (const j of cover) {
    const A = a[j] as number;
    const k = j * 3;
    const i = j * 4;
    const r0 = buf[i] as number;
    const g0 = buf[i + 1] as number;
    const b0 = buf[i + 2] as number;
    buf[i] = r0 + ((col[k] as number) - r0) * A;
    buf[i + 1] = g0 + ((col[k + 1] as number) - g0) * A;
    buf[i + 2] = b0 + ((col[k + 2] as number) - b0) * A;
    if (ent.solid[j]) {
      mark(f, out, j);
    }
  }
  // light goes on after the blend, as it did when each pixel was blended and then lit
  for (const j of lit) {
    const k = j * 3;
    const i = j * 4;
    buf[i] = (buf[i] as number) + (addc[k] as number);
    buf[i + 1] = (buf[i + 1] as number) + (addc[k + 1] as number);
    buf[i + 2] = (buf[i + 2] as number) + (addc[k + 2] as number);
  }
  if (ent.explicit) {
    out.explicit = true;
    for (let x = 0; x < W; x++) {
      lower(out.gtop, x, at(ent.gr, x));
    }
  }
}

/** Draw the static part of a layer into a cache entry (reusing its arrays when the size matches). */
function buildCache(
  prev: CacheEntry | undefined,
  f: Frame,
  pl: Placement,
  bases: readonly ContextBase[],
  keyBase: string,
  g: AnyGenerator,
  tryWhole: boolean
): CacheEntry {
  const { W, H } = f;
  const E: CacheEntry =
    prev && prev.W === W && prev.H === H
      ? prev
      : {
          a: new Float32Array(W * H),
          addc: new Float32Array(W * H * 3),
          col: new Float32Array(W * H * 3),
          cover: new Int32Array(0),
          explicit: false,
          fixedMoves: false,
          gen: null,
          gr: new Int16Array(W),
          H,
          keyBase: "",
          lit: new Int32Array(0),
          off: 0,
          panning: false,
          solid: new Uint8Array(W * H),
          still: false,
          W,
        };
  Object.assign(E, { gen: g, keyBase, off: pl.base, panning: false });
  // try the whole layer: if render asks for the time it moves, so keep only the static part
  const seen = drawIntoCache(E, f, pl, bases, g, tryWhole);
  E.still = tryWhole && !seen.render;
  E.fixedMoves = seen.renderStatic;
  if (tryWhole && seen.render && !seen.renderStatic) {
    drawIntoCache(E, f, pl, bases, g, false);
  }
  indexCache(E);
  return E;
}
/**
 * Draw renderStatic (and render, when whole) of every strip into a cleared cache entry. Says which of them asked for
 * the time or read the frame.
 */
function drawIntoCache(
  E: CacheEntry,
  f: Frame,
  pl: Placement,
  bases: readonly ContextBase[],
  g: AnyGenerator,
  whole: boolean
): { render: boolean; renderStatic: boolean } {
  E.col.fill(0);
  E.a.fill(0);
  E.addc.fill(0);
  E.solid.fill(0);
  E.gr.fill(f.H);
  E.explicit = false;
  const seen = { render: false, renderStatic: false };
  for (const [k, base] of bases.entries()) {
    const loc = locator(f, pl, k);
    const into = (part: keyof typeof seen): RenderContext =>
      makeContext({
        ...cacheBase(E, base, loc, pl),
        rng: stripRng(base.seed, k),
        touch: () => {
          seen[part] = true;
        },
      });
    g.renderStatic?.(into("renderStatic"));
    if (whole) {
      g.render(into("render"));
    }
  }
  return seen;
}
/** The primitives of a strip with plot, glow and setGround drawing into a cache entry instead of the frame. */
function cacheBase(
  E: CacheEntry,
  base: ContextBase,
  loc: (X: number, Y: number) => number,
  pl: Placement
): ContextBase {
  return {
    ...base,
    glow(X, Y, col, a = 1) {
      const j = loc(X, Y);
      if (j < 0 || a <= 0) {
        return;
      }
      for (let ch = 0; ch < 3; ch++) {
        E.addc[j * 3 + ch] = at(E.addc, j * 3 + ch) + at(col, ch) * a;
      }
    },
    opacity: 1,
    plot(X, Y, col, a = 1) {
      const j = loc(X, Y);
      if (j < 0 || a <= 0) {
        return;
      }
      const A = at(E.a, j);
      const nA = A + a * (1 - A);
      for (let ch = 0; ch < 3; ch++) {
        E.col[j * 3 + ch] =
          (at(E.col, j * 3 + ch) * A * (1 - a) + at(col, ch) * a) / nA;
        // light added before this plot is covered by it, as it would be live
        E.addc[j * 3 + ch] = at(E.addc, j * 3 + ch) * (1 - a);
      }
      E.a[j] = nA;
      if (a >= 0.5) {
        E.solid[j] = 1;
      }
    },
    setGround(X, Y) {
      E.explicit = true;
      lower(E.gr, Math.floor(X) - pl.base + pl.dx, Y + pl.dy);
    },
  };
}

/** Palette lock with ordered dither, then opaque alpha. */
function postProcess(
  scene: RenderScene,
  buf: Uint8ClampedArray,
  W: number,
  H: number
): void {
  const pal = paletteFor(scene.post?.palette ?? "none");
  if (!pal) {
    for (let i = 3; i < W * H * 4; i += 4) {
      buf[i] = 255;
    }
    return;
  }
  const dAmt = clamp01(Number(scene.post?.dither ?? 0.5)) * 48;
  // pixel art reuses a few colors: remember the nearest palette color per color and dither cell
  const memo = new Map<number, Color>();
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const r = buf[i] as number;
      const g = buf[i + 1] as number;
      const b = buf[i + 2] as number;
      const cell = (y & 3) * 4 + (x & 3);
      const key = ((r << 16) | (g << 8) | b) * 16 + cell;
      let best = memo.get(key);
      if (!best) {
        const n = (bay(x, y) - 0.5) * dAmt;
        best = nearest(pal, r + n, g + n, b + n);
        memo.set(key, best);
      }
      buf[i] = best[0];
      buf[i + 1] = best[1];
      buf[i + 2] = best[2];
      buf[i + 3] = 255;
    }
  }
}
function paletteFor(palette: string): Color[] | null {
  const name: PaletteName = isPalette(palette) ? palette : "none";
  let pc = PAL_CACHE.get(name);
  if (!pc || pc.src !== PALETTES[name]) {
    pc = { rgb: paletteRGB(name), src: PALETTES[name] };
    PAL_CACHE.set(name, pc);
  }
  return pc.rgb?.length ? pc.rgb : null;
}
function nearest(
  pal: readonly Color[],
  r: number,
  g: number,
  b: number
): Color {
  let best: Color = pal[0] ?? BLACK;
  let bd = 1e9;
  for (const q of pal) {
    const d =
      (r - q[0]) ** 2 * 0.3 + (g - q[1]) ** 2 * 0.59 + (b - q[2]) ** 2 * 0.11;
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}
