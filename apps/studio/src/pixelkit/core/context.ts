/* The render context: a handful of primitives the renderer supplies (where a pixel goes, the ground so far, the clock)
   and every helper built on them. The static cache builds contexts from its own primitives through the same function,
   so the helpers draw into the cache exactly as they would into the frame. */
import { blob, density, line, puff, rect, repeatX, tiles } from "./draw.ts";
import { frac, mod, mulberry32 } from "./math.ts";
import type {
  Color,
  EveryOptions,
  LayerTap,
  RenderContext,
  TimedEvent,
} from "./types.ts";

/** Loop-safe time for one frame (see createClock in renderer.ts). */
export interface Clock {
  cyc: (perSec: number, tol?: number) => number;
  flow: (
    p0: number,
    vel: number,
    span: number,
    phase?: number
  ) => [number, number];
  flow2: (
    x0: number,
    y0: number,
    vx: number,
    vy: number,
    sx: number,
    sy: number,
    phase?: number
  ) => [number, number, number];
  /** The issue raised since the last reset, or null. */
  issue: { need: number } | null;
  lm: (fn: (t: number) => number) => number;
  v: (pxPerSec: number, span: number, tol?: number) => number;
  /** A rate nudged to a whole number of periods per loop, when that changes it by at most tol. */
  w: (radPerSec: number, tol?: number) => number;
}

/** What the renderer supplies for one strip of one layer. */
export interface ContextBase {
  buf: Uint8ClampedArray;
  clearance: (x?: number) => number;
  clock: Clock;
  glow: (x: number, y: number, col: Color, a?: number) => void;
  groundY: (x: number) => number;
  H: number;
  isWater: (x: number, y: number) => boolean;
  left: number;
  loop: number;
  opacity: number;
  own: Uint8Array;
  p: unknown;
  plot: (x: number, y: number, col: Color, a?: number) => void;
  rng: () => number;
  scene: { w: number; h: number };
  seed: number;
  setGround: (x: number, y: number) => void;
  style: unknown;
  t: number;
  taps: readonly LayerTap[];
  /** Called whenever render asks for the time (or the taps): such a layer moves, so it cannot be cached whole. */
  touch: () => void;
  view: { w: number; h: number; left: number };
  W: number;
}

/** Most events c.every considers at once when they overlap (a very long duration without a loop). */
const MAX_OVERLAP = 256;

/** Events still under way at time t, for c.every. */
function every(
  b: ContextBase,
  period: number,
  fn: (e: TimedEvent) => void,
  opts: EveryOptions
): void {
  if (!(period > 0 && Number.isFinite(period))) {
    return;
  }
  const { t, loop, seed } = b;
  const per = 1 / b.clock.cyc(1 / period, opts.tol);
  const jitter = opts.jitter ?? 0;
  const duration = opts.duration ?? per;
  if (!(duration >= 0)) {
    return;
  }
  const n = loop ? Math.round(loop / per) : 0;
  const loops = n > 0 && Math.abs(n * per - loop) < 1e-6;
  const salt = opts.salt ?? 0;
  const shift = (opts.offset ?? 0) * per;
  const last = Math.floor((t + shift) / per + 1e-6);
  // an event that started a few periods ago may still be under way; a loop holds at most n of them
  const back = Math.min(
    Math.ceil((duration + jitter * per) / per),
    loops ? n : MAX_OVERLAP
  );
  for (let k = last - back; k <= last; k++) {
    const index = loops ? mod(k, n) : k;
    const rng = mulberry32(seed * 31 + index * 7919 + salt * 104_729);
    const start = k * per - shift;
    const age = jitter ? t - start - rng() * per * jitter : t - start;
    if (age >= 0 && age < duration) {
      fn({ age, index, progress: age / duration, rng });
    }
  }
}

/** A loop-safe rate, remembered per value for the frame: hot loops call wave and phase with the same few speeds. */
function memo(
  f: (rate: number, tol?: number) => number
): (rate: number, tol?: number) => number {
  const seen = new Map<number, number>();
  return (rate, tol) => {
    if (tol !== undefined) {
      return f(rate, tol);
    }
    let v = seen.get(rate);
    if (v === undefined) {
      v = f(rate);
      seen.set(rate, v);
    }
    return v;
  };
}

/** The context render(c) gets, built from the renderer's primitives. */
export function makeContext(b: ContextBase): RenderContext {
  const { clock, t, touch } = b;
  const { snap } = b.p as { snap?: unknown };
  const speed = memo(clock.w);
  const rate = memo(clock.cyc);
  const c: RenderContext = {
    blob: (circles, bottom, L, M, Sd, opts) =>
      blob(c, circles, bottom, L, M, Sd, opts),
    // reading the frame below makes a layer depend on it, like reading the time: it is drawn every frame
    get buf() {
      touch();
      return b.buf;
    },
    clearance: b.clearance,
    density: (n) => density(b, n),
    every(period, fn, opts = {}) {
      touch();
      every(b, period, fn, opts);
    },
    glow: b.glow,
    ground(x0, x1) {
      if (snap === false) {
        return;
      }
      if (x1 === undefined) {
        const g = b.groundY(x0);
        return g < b.H ? g : undefined;
      }
      // the lowest ground across x0..x1, so something wide never floats over a dip
      let m = -1;
      for (let x = Math.floor(x0); x <= Math.ceil(x1); x++) {
        const g = b.groundY(x);
        if (g < b.H && g > m) {
          m = g;
        }
      }
      return m < 0 ? undefined : m;
    },
    H: b.H,
    isWater(x, y) {
      touch();
      return b.isWater(x, y);
    },
    left: b.left,
    line: (x0, y0, x1, y1, col, a, th) => line(c, x0, y0, x1, y1, col, a, th),
    loop: b.loop,
    loopBlend(fn) {
      touch();
      return clock.lm(fn);
    },
    move: ((
      start: number | readonly [number, number],
      velocity: number | readonly [number, number],
      span: number | readonly [number, number],
      phase?: number
    ) => {
      touch();
      if (typeof start === "number") {
        return clock.flow(start, velocity as number, span as number, phase);
      }
      const [vx, vy] = velocity as readonly [number, number];
      const [sx, sy] = span as readonly [number, number];
      return clock.flow2(start[0], start[1], vx, vy, sx, sy, phase);
    }) as RenderContext["move"],
    opacity: b.opacity,
    get own() {
      touch();
      return b.own;
    },
    p: b.p as Record<string, unknown>,
    phase(r, offset, tol) {
      touch();
      return frac(t * rate(r, tol) + (offset ?? 0));
    },
    plot: b.plot,
    puff: (x, y, r, d, col, a) => puff(c, x, y, r, d, col, a),
    rect: (x, y, w, h, col, a) => rect(c, x, y, w, h, col, a),
    repeatX: (x, margin, fn) => repeatX(b, x, margin, fn),
    rng: b.rng,
    screenX: (x) => mod(x - b.left, b.W) + b.left,
    seed: b.seed,
    setGround: b.setGround,
    style: b.style,
    get t() {
      touch();
      return t;
    },
    get taps() {
      touch();
      return b.taps;
    },
    tiles(margin, fn, drift = 0) {
      if (!drift) {
        tiles(b, margin, fn);
        return;
      }
      // drifting tiles: shift by a loop-safe distance, and repeat every tile when looping so the drift comes back around
      touch();
      const shift = Math.round(clock.v(drift, b.W) * t);
      tiles(b, margin, fn, shift, b.loop ? 1 : 0);
    },
    view: b.view,
    W: b.W,
    wave(s, phase, tol) {
      touch();
      return Math.sin(t * speed(s, tol) + (phase ?? 0));
    },
  };
  return c;
}
