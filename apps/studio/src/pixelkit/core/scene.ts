/* Scene model. A scene is plain JSON: { width, height, fps, loop, camera, post, layers: [{ type, name, visible, opacity, blend, parallax, seed, params }] }.
   Everything that comes from JSON goes through normalizeScene, which clamps and checks every value against the generator's param specs,
   so a pasted scene can neither inject markup through a param nor freeze the renderer with an absurd count. */
import { clamp01 } from "./math.ts";
import { isPalette } from "./palettes.ts";
import type { ParamSpec } from "./params.ts";
import { GEN } from "./registry.ts";
import { cleanSprite } from "./sprite.ts";
import type { Layer, LayerFit, LayerShow, Scene, SceneSize } from "./types.ts";
import { warnOnce } from "./warn.ts";

let uidN = 1;
export const uid = (): string => {
  uidN += 1;
  return `l${uidN}${Math.random().toString(36).slice(2, 5)}`;
};
const num = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const COLOR = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
type Params = Record<string, unknown>;

/** One param value cleaned against its spec: ranges clamped, colors checked, selects limited to their options. */
export function cleanParam(spec: ParamSpec, v: unknown): unknown {
  switch (spec.type) {
    case "range":
      return num(v, spec.min, spec.max, spec.def);
    case "color": {
      if (typeof v !== "string" || !COLOR.test(v)) {
        return spec.def;
      }
      const h = v.slice(1).toLowerCase();
      return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
    }
    case "bool":
      return v === undefined ? spec.def : Boolean(v);
    case "select":
      if (typeof v === "string" && spec.options.includes(v)) {
        return v;
      }
      if (spec.styles && typeof v === "string") {
        warnOnce(
          `No style "${v}" (${spec.options.join(", ")}): using "${spec.def}". A style of your own has to be registered with registerStyle() before the scene is loaded.`
        );
      }
      return spec.def;
    case "sprite":
      return cleanSprite(v) ?? spec.def;
    default:
      // a spec type this core does not know (from a pasted module): keep its default
      return (spec as { def?: unknown }).def;
  }
}
const known = (type: unknown): type is string =>
  typeof type === "string" && Object.hasOwn(GEN, type);
const specs = (type: string) =>
  (GEN[type] as NonNullable<(typeof GEN)[string]>).params;
/** Params cleaned against a generator's specs. Unknown keys are dropped; missing ones get defaults. */
export function cleanParams(
  type: string,
  params: Params | null | undefined = {}
): Params {
  const out: Params = {};
  for (const [k, s] of Object.entries(specs(type))) {
    out[k] = cleanParam(s, params ? params[k] : undefined);
  }
  return out;
}
/** Default param values for a generator id. */
export function defaults(type: string): Params {
  const o: Params = {};
  for (const [k, s] of Object.entries(specs(type))) {
    o[k] = s.def;
  }
  return o;
}
/** New layer for a generator, with defaults filled in. */
export function makeLayer(
  type: string,
  params: Params = {},
  extra: Partial<Omit<Layer, "type" | "params">> = {}
): Layer & { id: string } {
  if (!known(type)) {
    throw unknownGenerator(type);
  }
  const g = GEN[type] as NonNullable<(typeof GEN)[string]>;
  return {
    blend: g.blend ?? "normal",
    id: uid(),
    name: g.label,
    opacity: 1,
    parallax: g.parallax ?? 1,
    seed: Math.floor(Math.random() * 1e6),
    type,
    visible: true,
    ...extra,
    params: cleanParams(type, params),
  } as Layer & { id: string };
}
const FIT_X = ["extend", "stretch", "left", "center", "right"] as const;
const FIT_Y = ["stretch", "top", "center", "bottom"] as const;
const oneOf = <T extends string>(
  options: readonly T[],
  v: unknown
): T | undefined => options.find((o) => o === v);
/** A layer's fit from JSON, or undefined when it says nothing valid. */
function cleanFit(v: unknown): LayerFit | undefined {
  if (!v || typeof v !== "object") {
    return;
  }
  const f = v as Record<string, unknown>;
  const x = oneOf(FIT_X, f.x);
  const y = oneOf(FIT_Y, f.y);
  if (!(x || y)) {
    return;
  }
  return { ...(x ? { x } : {}), ...(y ? { y } : {}) };
}
/** A layer's show range from JSON, or undefined when it has no valid bound. */
function cleanShow(v: unknown): LayerShow | undefined {
  if (!v || typeof v !== "object") {
    return;
  }
  const s = v as Record<string, unknown>;
  // a bound that is not a number is left out, not read as 0
  const bound = (n: unknown) =>
    typeof n === "number" && Number.isFinite(n)
      ? Math.round(num(n, 0, 4096, 0))
      : undefined;
  const minWidth = bound(s.minWidth);
  const maxWidth = bound(s.maxWidth);
  if (minWidth === undefined && maxWidth === undefined) {
    return;
  }
  // a range given backwards is meant the right way round
  const [lo, hi] =
    minWidth !== undefined && maxWidth !== undefined && minWidth > maxWidth
      ? [maxWidth, minWidth]
      : [minWidth, maxWidth];
  return {
    ...(lo === undefined ? {} : { minWidth: lo }),
    ...(hi === undefined ? {} : { maxWidth: hi }),
  };
}
/** A scene's size from JSON, or undefined for the default (fixed). */
function cleanSize(v: unknown): SceneSize | undefined {
  if (!v || typeof v !== "object") {
    return;
  }
  const s = v as Record<string, unknown>;
  const minPixel = Math.round(num(s.minPixel, 1, 16, 1));
  return {
    maxPixel: Math.max(minPixel, Math.round(num(s.maxPixel, 1, 16, 8))),
    minPixel,
    mode: s.mode === "fill" ? "fill" : "fixed",
  };
}

/** The error for a layer whose generator was never registered: which one, and what to do about it. */
export function unknownGenerator(type: unknown): Error {
  const near = closest(String(type), Object.keys(GEN));
  const hint = near ? ` Did you mean "${near}"?` : "";
  return new Error(
    `Unknown generator "${String(type)}".${hint} Generators have to be registered before a scene uses them: import "@pixelkit/generators" for the built-in ones, or register() your own (pixelkit add prints the lines).`
  );
}
/** The name in names nearest to s, when it is only a typo away (an edit distance of at most a third of its length, and 2). */
export function closest(s: string, names: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = Math.min(2, Math.floor(s.length / 3));
  for (const n of names) {
    const d = editDistance(s.toLowerCase(), n.toLowerCase());
    if (d <= bestD && n !== s) {
      best = n;
      bestD = d - 1;
    }
  }
  return best;
}
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Validate a layer from JSON and fill in anything missing. */
export function normalizeLayer(input: unknown): Layer & { id: string } {
  const L = (input ?? {}) as Partial<Record<keyof Layer, unknown>>;
  const fit = cleanFit(L.fit);
  const show = cleanShow(L.show);
  if (!known(L.type)) {
    throw unknownGenerator(L.type);
  }
  const g = GEN[L.type] as NonNullable<(typeof GEN)[string]>;
  const blend =
    L.blend === "add" || L.blend === "normal" ? L.blend : (g.blend ?? "normal");
  return makeLayer(L.type, (L.params ?? {}) as Params, {
    blend,
    name:
      typeof L.name === "string" && L.name.trim()
        ? L.name.slice(0, 80)
        : g.label,
    opacity: num(L.opacity, 0, 1, 1),
    parallax: num(L.parallax, 0, 2, g.parallax ?? 1),
    seed: Number.isFinite(Number(L.seed))
      ? Math.trunc(Number(L.seed)) | 0
      : Math.floor(Math.random() * 1e6),
    visible: L.visible !== false,
    ...(fit ? { fit } : {}),
    ...(show ? { show } : {}),
    ...(L.avoid === true ? { avoid: true } : {}),
  });
}
export const MAX_LAYERS = 64;
/** The largest view the renderer draws, in pixels per side. */
export const MAX_VIEW = 2048;
/** Validate a whole scene from JSON. */
export function normalizeScene(input: unknown): Scene<Layer & { id: string }> {
  if (!input || typeof input !== "object") {
    throw new Error("A scene must be a JSON object.");
  }
  const s = input as Record<string, unknown> & {
    camera?: Record<string, unknown>;
    post?: Record<string, unknown>;
  };
  const W = Number.parseInt(String(s.width), 10),
    H = Number.parseInt(String(s.height), 10);
  if (!(W >= 16 && W <= 512 && H >= 16 && H <= 512)) {
    throw new Error("width and height must be between 16 and 512.");
  }
  if (!Array.isArray(s.layers)) {
    throw new Error('"layers" must be an array.');
  }
  if (s.layers.length > MAX_LAYERS) {
    throw new Error(`A scene can have at most ${MAX_LAYERS} layers.`);
  }
  const palette = s.post?.palette;
  const size = cleanSize(s.size);
  return {
    camera: {
      speed: num(s.camera?.speed, -200, 200, 0),
      x: num(s.camera?.x, -1e6, 1e6, 0),
    },
    fps: Math.round(num(s.fps, 1, 30, 12)),
    height: H,
    layers: s.layers.map(normalizeLayer),
    loop: Math.round(num(s.loop, 0, 64, 0)),
    post: {
      dither: clamp01(num(s.post?.dither, 0, 1, 0.5)),
      palette: isPalette(palette) ? palette : "none",
    },
    width: W,
    ...(size ? { size } : {}),
  };
}

/**
 * How a scene shows in a box: the size of one scene pixel in CSS pixels (pixel) and in device pixels (devicePixel, always
 * a whole number, so every scene pixel covers the same screen pixels), and the view size in scene pixels.
 */
export interface View {
  devicePixel: number;
  height: number;
  pixel: number;
  width: number;
}
/**
 * The view for a scene in a cssWidth x cssHeight box (pass 0 for a height that follows the width) on a screen with the
 * given devicePixelRatio. Fixed scenes keep their size at the largest whole scale that fits (at least 1). Scenes sized
 * 'fill' take the largest pixel size that fits their own size into the box, kept between size.minPixel and
 * size.maxPixel CSS pixels, and a view that covers the box. Pixel sizes are whole device pixels, so on a 1.5x screen a
 * scene pixel can be 2 or 2.67 CSS pixels.
 */
export function fitView(
  scene: Pick<Scene, "width" | "height" | "size">,
  cssWidth: number,
  cssHeight = 0,
  devicePixelRatio = 1
): View {
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
      ? devicePixelRatio
      : 1;
  // work in device pixels
  const w = Math.max(0, cssWidth || 0) * dpr;
  const h = Math.max(0, cssHeight || 0) * dpr;
  const fitW = w / Math.max(1, scene.width);
  const fitH = h > 0 ? h / Math.max(1, scene.height) : fitW;
  const scale = Math.floor(Math.min(fitW, fitH));
  const { size } = scene;
  if (size?.mode !== "fill") {
    const devicePixel = Math.max(Math.ceil(dpr), scale);
    return {
      devicePixel,
      height: scene.height,
      pixel: devicePixel / dpr,
      width: scene.width,
    };
  }
  const lo = Math.max(1, Math.ceil(size.minPixel * dpr - 1e-9));
  const hi = Math.max(lo, Math.floor(size.maxPixel * dpr + 1e-9));
  const devicePixel = Math.min(hi, Math.max(lo, scale));
  return {
    devicePixel,
    height:
      h > 0
        ? Math.min(MAX_VIEW, Math.max(1, Math.ceil(h / devicePixel)))
        : scene.height,
    pixel: devicePixel / dpr,
    width: Math.min(MAX_VIEW, Math.max(1, Math.ceil(w / devicePixel))),
  };
}
/** Scene as shareable JSON (layer ids stripped). */
export const exportScene = (scene: Scene) => ({
  camera: scene.camera,
  fps: scene.fps,
  height: scene.height,
  layers: scene.layers.map(({ id: _id, ...rest }) => rest),
  loop: scene.loop,
  post: scene.post,
  version: 3,
  width: scene.width,
  ...(scene.size ? { size: scene.size } : {}),
});
