/* Param spec builders. A generator's params object maps keys to these specs; the studio builds its controls from them,
   scene JSON stores the values, and the types below turn a params object into the type of c.p. */
import { freezeSprite, type SpriteValue } from "./sprite.ts";
import type { Color } from "./types.ts";

export interface RangeSpec {
  def: number;
  label: string;
  max: number;
  min: number;
  step: number;
  type: "range";
}
export interface ColorSpec {
  /** '#rrggbb' */
  def: string;
  label: string;
  type: "color";
}
export interface BoolSpec {
  def: boolean;
  label: string;
  type: "bool";
}
export interface SelectSpec<O extends string = string> {
  def: O;
  label: string;
  /** Display names for options, when they differ from the option id. */
  labels?: Record<string, string>;
  options: O[];
  /** Options come from the generator's registered styles. */
  styles?: boolean;
  type: "select";
}
/** Hand-drawn pixel art (see sprite.ts for the format). */
export interface SpriteSpec {
  def: SpriteValue;
  label: string;
  type: "sprite";
}
export type ParamSpec =
  | RangeSpec
  | ColorSpec
  | BoolSpec
  | SelectSpec
  | SpriteSpec;
export type ParamSpecs = Record<string, ParamSpec>;

/** The value type a spec stores in scene JSON: number, '#rrggbb' string, boolean or one of the select options. */
export type ParamValue<S> = S extends RangeSpec
  ? number
  : S extends ColorSpec
    ? string
    : S extends BoolSpec
      ? boolean
      : S extends SelectSpec<infer O>
        ? O
        : S extends SpriteSpec
          ? SpriteValue
          : never;
/** The params as scene JSON stores them (colors as '#rrggbb'). */
export type ParamValues<P extends ParamSpecs> = {
  [K in keyof P]: ParamValue<P[K]>;
};
/** The value render sees for a spec: the stored value, except colors, which arrive as [r, g, b]. */
export type RenderValue<S> = S extends ColorSpec ? Color : ParamValue<S>;
/** The type of c.p: the params as render sees them. */
export type RenderValues<P extends ParamSpecs> = {
  [K in keyof P]: RenderValue<P[K]>;
};

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
/** Whole numbers over a span wider than 1 step by 1 (a count, a size in pixels); anything else by 0.01 (0 to 1 is a fraction). */
const stepFor = (min: number, max: number, def: number): number =>
  Number.isInteger(min) &&
  Number.isInteger(max) &&
  Number.isInteger(def) &&
  max - min > 1
    ? 1
    : 0.01;

/**
 * The param builders. A generator's params object maps keys to these; the studio builds its controls from them, scene
 * JSON stores the values, and render reads them as c.p (typed from the builders):
 *   params: { count: param.range("Count", 0, 40, 8), color: param.color("Color", "#2f5a3a"), ...param.snap() }
 */
export const param = {
  /** A color picker. Scene JSON stores '#rrggbb'; render gets [r, g, b]. */
  color: (label: string, def: string): ColorSpec => {
    if (!HEX.test(def)) {
      throw new Error(
        `param.color("${label}", "${def}"): the default must be a hex color like "#ff9a4a".`
      );
    }
    return { def, label, type: "color" };
  },
  /** A slider from min to max, starting at def. Steps by 1 when all three are whole numbers over a span wider than 1, else by 0.01, unless step is given. */
  range: (
    label: string,
    min: number,
    max: number,
    def: number,
    opts: { step?: number } = {}
  ): RangeSpec => {
    const step = opts.step ?? stepFor(min, max, def);
    if (!(min < max && def >= min && def <= max && step > 0)) {
      throw new Error(
        `param.range("${label}", ${min}, ${max}, ${def}): the default must be between min and max, min below max, and the step above 0.`
      );
    }
    return { def, label, max, min, step, type: "range" };
  },
  /** A dropdown. The value type is the union of the options. */
  select: <const O extends string>(
    label: string,
    options: readonly O[],
    def: NoInfer<O>,
    labels?: Record<O, string>
  ): SelectSpec<O> => ({
    def,
    label,
    options: [...options],
    type: "select",
    ...(labels ? { labels } : {}),
  }),
  /** For props that stand on the ground: "Sit on ground" (snap), which c.ground follows, and "Ground depth" (sink), how far to sink in. */
  snap: () => ({
    sink: param.range("Ground depth", 0, 40, 2),
    snap: param.toggle("Sit on ground", true),
  }),
  /** Pixel art drawn as rows of characters (see sprite.ts); the studio edits it as text. */
  sprite: (label: string, def: SpriteValue): SpriteSpec => ({
    def: freezeSprite(def),
    label,
    type: "sprite",
  }),
  /** A checkbox. */
  toggle: (label: string, def: boolean): BoolSpec => ({
    def,
    label,
    type: "bool",
  }),
};

/** The style dropdown defineGenerator adds for a generator with styles; its options are the style ids. */
export const styleSelect = (label: string, def: string): SelectSpec => ({
  def,
  label,
  options: [],
  styles: true,
  type: "select",
});
