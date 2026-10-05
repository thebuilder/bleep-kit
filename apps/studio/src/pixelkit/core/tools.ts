/* @pixelkit/core/tools: the internals the studio, the CLI and tests share. Not needed to write a generator or show a
   scene; see index.ts for that. */
// biome-ignore lint/performance/noBarrelFile: a package entry point
export { checkStyle, ID_RE, KINDS, styleOf } from "./define.ts";
export { BAYER } from "./math.ts";
export { isPalette, PALETTES, paletteRGB } from "./palettes.ts";
export { styleSelect } from "./params.ts";
export { GEN } from "./registry.ts";
export {
  CAMERA_ISSUE,
  clearStaticCache,
  KIND_CODE,
  KIND_ORDER,
  LOOP_OPTIONS,
  MAX_KEEP_OUT,
} from "./renderer.ts";
export {
  cleanParam,
  cleanParams,
  closest,
  defaults,
  MAX_LAYERS,
  MAX_VIEW,
  makeLayer,
  normalizeLayer,
  uid,
  unknownGenerator,
} from "./scene.ts";
export {
  cleanSprite,
  formatSprite,
  parseSprite,
  SPRITE_LIMITS,
  spriteWarnings,
} from "./sprite.ts";
