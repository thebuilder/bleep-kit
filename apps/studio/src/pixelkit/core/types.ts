/* The contract between the core and every generator or style, built-in, ejected or your own.
   The core may change internally; the shapes in this file stay stable within a major version. */
import type { ParamSpecs } from "./params.ts";

/** [r, g, b], 0 to 255. Scene JSON stores colors as '#rrggbb'; c.p hands them to render as [r, g, b]. */
export type Color = readonly [number, number, number];

export type Kind = "background" | "foreground" | "effect" | "light" | "post";
export type Blend = "normal" | "add";

/**
 * What render(c) receives. Everything a generator needs is on c.
 *
 * Coordinates: y is rows from the top of the layer. x is world x: the layer's left edge is at c.left, which moves as
 * the camera pans (times the layer's parallax). Things placed in the world (trees, rocks, a fire) use world x directly;
 * things that cover the screen whatever the camera does (rain, a flash) take a screen column through c.screenX(x).
 *
 * Time: c.t is seconds, and c.loop the loop length (0 when the scene does not loop). Motion made with c.wave, c.phase,
 * c.move and c.every comes back to its start at the end of the loop on its own, nudging a speed slightly when that is
 * enough; when it is not, the studio reports which loop length the layer needs.
 *
 * Caching: a layer that never asks for the time (c.t, the time helpers, c.taps) or reads the frame below it (c.buf,
 * c.own, c.isWater) draws the same picture every frame, so the renderer keeps it and stops calling render until its
 * params, the view or the ground below change. Nothing to declare, as long as render draws from c alone: a generator
 * that draws from anything else (page state, data that arrives later) sets live: true.
 */
export interface RenderContext<V = Record<string, unknown>, S = unknown> {
  /**
   * A soft round shape made of circles, with a flat bottom: lit on top (L), body color (M), shade low and to the right
   * (Sd). For canopies, bushes, clouds and boulders. Returns inside(x, y).
   */
  blob: (
    circles: readonly Circle[],
    bottom: number,
    L: Color,
    M: Color,
    Sd: Color,
    opts?: BlobOptions
  ) => (x: number, y: number) => boolean;

  // Filters (generators with filter: true) read and write the frame directly.
  /** RGBA frame so far. */
  readonly buf: Uint8ClampedArray;
  /** For a layer with avoid set: the row just below the keep-out zones (text over the scene) at world x, or anywhere with no x; 0 when nothing is kept out. */
  clearance: (x?: number) => number;
  /** A count of scattered things (rain drops, stars) scaled to the area this layer covers, so a wide page keeps the density. */
  density: (n: number) => number;
  /**
   * Something that happens every period seconds (a lightning strike, a wave, a shooting star). fn runs for each event
   * under way, 0 <= age < duration: age is the seconds since it started, index identifies it (the same event every
   * loop), rng is seeded for that event. In a loop the period becomes the nearest that fits a whole number of times,
   * when its rate changes by at most tol (25%).
   */
  every: (
    period: number,
    fn: (e: TimedEvent) => void,
    opts?: EveryOptions
  ) => void;
  /** Add light to a pixel, whatever the layer's blend. */
  glow: (x: number, y: number, col: Color, a?: number) => void;

  // The world so far.
  /**
   * Where to stand at world x: y of the ground earlier layers drew there, or, from x to x1, the lowest ground across
   * them, so something wide never floats over a dip. undefined when there is no ground, or when the layer's "Sit on
   * ground" param (param.snap) is off: stand at your own height then, c.ground(x) ?? fallback.
   */
  ground: (x: number, x1?: number) => number | undefined;
  readonly H: number;
  /** True when the pixel at (x, y) was last covered by water. */
  isWater: (x: number, y: number) => boolean;
  /** World x of the layer's left edge. */
  readonly left: number;
  /** A line, th pixels thick (thickness grows to the right). */
  line: (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    col: Color,
    a?: number,
    th?: number
  ) => void;
  /** Loop length in seconds, 0 when the scene does not loop. */
  readonly loop: number;
  /** fn(t) cross-faded with fn(t - loop), so noise scrolled by time loops. */
  loopBlend: (fn: (t: number) => number) => number;
  /**
   * Something moving at speed pixels a second through a span that wraps (a raindrop, a bird): [position, alpha]. Alpha
   * fades it out and back in at the loop's seam when a lap does not fit the loop. In two directions at once, pass
   * [x, y] pairs and get [x, y, alpha].
   */
  move(
    start: number,
    speed: number,
    span: number,
    phase?: number
  ): [pos: number, alpha: number];
  move(
    start: readonly [number, number],
    speed: readonly [number, number],
    span: readonly [number, number],
    phase?: number
  ): [x: number, y: number, alpha: number];
  /** Layer opacity, 0 to 1. plot and glow apply it already; use it only when writing buf directly. */
  readonly opacity: number;
  /** Per-pixel owner: 1 background, 2 foreground (used by shadows and rim light). */
  readonly own: Uint8Array;
  // What to draw.
  /** The layer's params, defaults filled in. Colors arrive as [r, g, b]. */
  readonly p: V;
  /** A sawtooth from 0 to 1, rate times a second, starting at offset. For anything that cycles: frames, life of a particle. */
  phase: (rate: number, offset?: number, tol?: number) => number;

  // Drawing.
  /** Draw a pixel: blended normally, or added for a layer set to blend "add". a is 0 to 1. */
  plot: (x: number, y: number, col: Color, a?: number) => void;
  /**
   * A soft, dithered round puff (smoke, dust, steam) of radius r around (x, y). fill 0 to 1 is how full it is; it thins
   * toward the edge.
   */
  puff: (
    x: number,
    y: number,
    r: number,
    fill: number,
    col: Color,
    a?: number
  ) => void;
  /** A filled rectangle. */
  rect: (
    x: number,
    y: number,
    w: number,
    h: number,
    col: Color,
    a?: number
  ) => void;
  /** A single thing at world x (a sun, a fire), repeated every layer width so it comes back around while panning. */
  repeatX: (x: number, margin: number, fn: (x: number) => void) => void;
  /**
   * Seeded random numbers in [0, 1), the same sequence every frame: call it in the same order every frame. render and
   * renderStatic each get their own stream.
   */
  rng: () => number;
  /** World x of screen column x, for things that cover the screen and do not move with the camera. */
  screenX: (x: number) => number;
  readonly seed: number;
  /**
   * Publish y as the ground at world x for later layers. A solid layer that calls this publishes only these columns
   * (grass publishes its fill line, not its blade tips); otherwise the top of its opaque pixels is used.
   */
  setGround: (x: number, y: number) => void;
  /** The active style, for a generator with styles. */
  readonly style: S;

  // Time.
  readonly t: number;
  /** Taps so far, newest last (only when the scene is played interactively). */
  readonly taps: readonly LayerTap[];
  /**
   * Scatter things across the world in tiles one layer-width wide, so panning never runs out. fn(rng, tileLeft, index)
   * runs for every tile that can show: place things at tileLeft + rng() * c.W. margin is how far a thing reaches past
   * its tile. drift moves the whole pattern that many pixels a second (drifting clouds), loop-safe.
   */
  tiles: (
    margin: number,
    fn: (rng: () => number, tileLeft: number, index: number) => void,
    drift?: number
  ) => void;
  /** The whole view: its size, and the world x at its left edge (c.left unless the layer is pinned or split). */
  readonly view: {
    readonly w: number;
    readonly h: number;
    readonly left: number;
  };

  // Where.
  /** Width and height this layer draws across (see LayerFit for how a layer fills a view larger than the scene). */
  readonly W: number;
  /** Math.sin(t * speed + phase), speed in radians per second. For sway, bobbing, flicker. */
  wave: (speed: number, phase?: number, tol?: number) => number;
}

/** A circle of a blob. */
export interface Circle {
  r: number;
  x: number;
  y: number;
}
export interface BlobOptions {
  /** Override the color of a pixel: return a color, or null to keep the shading. */
  dot?:
    | ((
        x: number,
        y: number,
        top: boolean,
        low: boolean
      ) => Color | null | undefined)
    | null;
  /** Moves the line between body and shade down. */
  lowBias?: number;
  seed?: number;
  /** Vertical squash of the circles (1 round). */
  squash?: number;
  /** Share of pixels speckled with shade, 0 to 1, seeded by seed. */
  tex?: number;
}

/** One run of a c.every event. */
export interface TimedEvent {
  /** Seconds since it started. */
  readonly age: number;
  /** Which event: counts up, and repeats every loop. */
  readonly index: number;
  /** 0 to 1: how far through its duration it is (age / duration). */
  readonly progress: number;
  /** Random numbers seeded for this event (after the draw jitter used, if any). */
  rng: () => number;
}
export interface EveryOptions {
  /** How long an event lasts, in seconds (default: one period). Overlapping events are each called back, up to a loop's worth. */
  duration?: number;
  /** 0 to 1: each start moves later by up to this share of the period. */
  jitter?: number;
  /** 0 to 1: start every event earlier by this share of the period (events at different points of their cycle). */
  offset?: number;
  /** Tell two c.every calls in one generator apart, so their events get different random numbers. */
  salt?: number;
  /** How far the rate (1 / period) may change to fit the loop, as a share of it (default 0.25). */
  tol?: number;
}

/** A tap as a layer sees it. */
export interface LayerTap {
  /** Seconds since the tap. */
  readonly age: number;
  /** The tap landed on a pixel this layer drew. */
  readonly hit: boolean;
  /** World x and layer y of the tap. */
  readonly x: number;
  readonly y: number;
}

/** What every style carries besides its hooks. */
export interface StyleInfo<
  Id extends string = string,
  G extends string = string,
> {
  /** The id of the generator it belongs to. */
  readonly generator: G;
  readonly id: Id;
  readonly isStyle: true;
  readonly label?: string;
}
/** A style: the hooks its generator documents (H) plus its identity. */
export type Style<
  H = object,
  Id extends string = string,
  G extends string = string,
> = H & StyleInfo<Id, G>;

/** What a generator and the spec passed to defineGenerator have in common. V is the type of c.p, S of c.style. */
export interface GeneratorBase<V, S = unknown> {
  /** Default blend for new layers. */
  blend?: Blend;
  /** Reads and rewrites c.buf instead of drawing shapes. */
  filter?: boolean;
  /**
   * How layers of this generator fill a view wider than the scene, unless the layer says otherwise (Layer.fit):
   * 'extend' draws more of the world (content is placed in world coordinates, like c.tiles()), 'stretch' (the default)
   * draws once across the whole view, and 'screen' is for generators that read c.buf by screen position: always the
   * whole view, never anchored. Filters are always 'screen'.
   */
  fit?: GeneratorFit;
  kind: Kind;
  label: string;
  /**
   * render reads something besides c (state your page changes, data that arrives later): draw it every frame. Without
   * it, render must draw from c alone, since a layer that never asks for the time is drawn once and cached.
   */
  live?: boolean;
  /** Default parallax depth for new layers (0 fixed, 1 moves with the camera). 1 when left out. */
  parallax?: number;
  render: (c: RenderContext<V, S>) => void;
  /**
   * Optional: the part that never changes, drawn before render and cached. Only worth it for a layer that moves but has
   * a large still part (a sky's gradient under twinkling stars): a layer that never asks for the time is cached anyway.
   */
  renderStatic?: (c: RenderContext<V, S>) => void;
  /** Publishes its top edge as ground for later layers. */
  solid?: boolean | ((p: V) => boolean);
  /** Marks its opaque pixels as water for c.isWater(). */
  wet?: boolean;
}
/**
 * A generator after defineGenerator. V is the type of c.p, H the hooks its styles provide, and Stored its params as scene
 * JSON holds them (colors as '#rrggbb' strings rather than [r, g, b]).
 */
// biome-ignore lint/suspicious/noExplicitAny: the defaults let one registry hold generators with different params
type Loose = any;
export interface Generator<
  V = Loose,
  Id extends string = string,
  H = Loose,
  Stored = Loose,
> extends GeneratorBase<V, Style<H>> {
  readonly id: Id;
  params: ParamSpecs;
  /** Type only: the params as scene JSON stores them. Never set. */
  readonly stored?: Stored;
  /** Set by defineGenerator from the styles array. */
  styles?: Record<string, Style<H>>;
  /** Bumped by registerStyle; part of the static cache key. */
  version?: number;
}
// biome-ignore lint/suspicious/noExplicitAny: any generator, whatever its params
export type AnyGenerator = Generator<any, string, any, any>;

export type GeneratorFit = "extend" | "stretch" | "screen";
/**
 * How a layer fills a view larger than the scene. x: 'extend' shows more world, 'stretch' spreads the layer across the
 * view, 'left' / 'center' / 'right' keep it at scene width pinned to that side. y: 'stretch' spreads it over the view
 * height, 'top' / 'center' / 'bottom' keep it at scene height pinned to that edge.
 */
export interface LayerFit {
  x?: "extend" | "stretch" | "left" | "center" | "right";
  y?: "stretch" | "top" | "center" | "bottom";
}
/** Show the layer only while the view is at least minWidth and at most maxWidth pixels wide. */
export interface LayerShow {
  maxWidth?: number;
  minWidth?: number;
}

/** A layer. normalizeScene fills in anything missing and clamps values; id is optional in JSON (the studio assigns one). */
export interface Layer<
  Type extends string = string,
  P = Record<string, unknown>,
> {
  /** Keep out of the keep-out zones (text over the scene): clipped out of them, and told where they are by c.clearance(). */
  avoid?: boolean;
  blend: Blend;
  /** How the layer fills a view larger than the scene; the generator's fit when left out. */
  fit?: LayerFit;
  id?: string;
  name: string;
  /** 0 to 1 */
  opacity: number;
  /** 0 to 2 */
  parallax: number;
  params: P;
  seed: number;
  /** Show the layer only at some view widths, for compositions that change between narrow and wide. */
  show?: LayerShow;
  type: Type;
  visible: boolean;
}
export interface Scene<L extends Layer = Layer> {
  camera: { x: number; speed: number };
  fps: number;
  height: number;
  layers: L[];
  /** Loop length in seconds, 0 for no loop. */
  loop: number;
  /** Source of imported modules this scene uses (studio only). */
  modules?: string[];
  name?: string;
  post: { palette: string; dither: number };
  /** How the scene is sized on a page; fixed when left out. */
  size?: SceneSize;
  version?: number;
  width: number;
}
/**
 * 'fixed' shows the scene at its own size, scaled by a whole number. 'fill' fills its container: the pixel size is the
 * largest whole number that fits the scene's own size into the container (between minPixel and maxPixel), and the view
 * grows to cover the rest, so a wider page shows more of the world instead of a bigger picture.
 */
export interface SceneSize {
  maxPixel: number;
  minPixel: number;
  mode: "fixed" | "fill";
}
/** A rectangle in view pixels. */
export interface Rect {
  h: number;
  w: number;
  x: number;
  y: number;
}
/** A tap on the view: when (absolute time, like tAbs), where (view pixels) and which layer it hit (an index into layers). */
export interface TapEvent {
  at: number;
  layer?: number;
  x: number;
  y: number;
}
/** What the renderer accepts: a layer needs only its type; anything else falls back to the generator's defaults. */
export type RenderLayer = Pick<Layer, "type"> & Partial<Omit<Layer, "type">>;
/**
 * What the renderer accepts: the size and the layers are required; layers may leave fields out, the camera defaults to
 * still at x 0, looping to off and the post step to full color (see normalizeScene for a complete, validated scene).
 */
export interface RenderScene {
  camera?: Partial<Scene["camera"]>;
  height: number;
  layers: readonly RenderLayer[];
  /** Loop length in seconds, 0 or missing for no loop. */
  loop?: number;
  post?: Partial<Scene["post"]>;
  size?: SceneSize;
  width: number;
}
/** One frame's loop problems: a layer that cannot loop at scene.loop (need = shortest working loop length, or 0), or the camera. */
export type LoopIssues = Map<RenderLayer | "camera", { need: number }>;
