/* @pixelkit/core: what generators, styles and pages use. Ejected files import from here. The studio, the CLI and tests
   also use @pixelkit/core/tools (the registry, scene cleaning, limits). */
// biome-ignore lint/performance/noBarrelFile: this is the package entry point; ejected modules import everything from @pixelkit/core
export { BLACK, mix, rgb, WHITE } from "./color.ts";
export {
  type ActiveStyle,
  defineGenerator,
  defineStyle,
  type GeneratorSpec,
  type GeneratorValues,
  type StoredValues,
  type StyleSpec,
  styleFor,
  type ValuesOf,
  withDefaults,
} from "./define.ts";
export { field } from "./draw.ts";
export {
  bay,
  clamp01,
  fbm,
  fbm2,
  frac,
  hash2,
  mod,
  mulberry32,
  TAU,
  vnoise,
} from "./math.ts";
export type { PaletteName } from "./palettes.ts";
export {
  type BoolSpec,
  type ColorSpec,
  type ParamSpec,
  type ParamSpecs,
  type ParamValue,
  type ParamValues,
  param,
  type RangeSpec,
  type RenderValue,
  type RenderValues,
  type SelectSpec,
  type SpriteSpec,
} from "./params.ts";
export { register, registerStyle } from "./registry.ts";
export {
  createRenderer,
  type FrameOptions,
  loopFor,
  type Renderer,
  renderFrame,
  type ViewSize,
} from "./render.ts";
export { exportScene, fitView, normalizeScene, type View } from "./scene.ts";
export {
  freezeSprite,
  type SpriteValue,
  spriteColors,
  spriteSize,
} from "./sprite.ts";
export type * from "./types.ts";
