/* defineGenerator and styleFor: the entry points an ejected or custom module uses. See types.ts for every field. */
import {
  type ParamSpecs,
  type ParamValues,
  type RenderValues,
  type SelectSpec,
  styleSelect,
} from "./params.ts";
import type {
  AnyGenerator,
  Generator,
  GeneratorBase,
  Kind,
  Style,
  StyleInfo,
} from "./types.ts";
import { warnOnce } from "./warn.ts";

export const KINDS: readonly Kind[] = [
  "background",
  "foreground",
  "effect",
  "light",
  "post",
];
export const ID_RE = /^[a-z][a-z0-9-]*$/;

/** The params with the style param narrowed to the ids of the generator's styles. */
type WithStyle<V, SId extends string> = string extends SId
  ? V
  : Omit<V, "style"> & { style: SId };
/** The type of c.p: the params as render sees them (colors as [r, g, b]). */
export type GeneratorValues<
  P extends ParamSpecs,
  SId extends string,
> = WithStyle<RenderValues<P>, SId>;
/** The params as scene JSON stores them (colors as '#rrggbb'). */
export type StoredValues<P extends ParamSpecs, SId extends string> = WithStyle<
  ParamValues<P>,
  SId
>;

/** The type of c.style: the active style for a generator with styles, undefined without. */
export type ActiveStyle<H, SId extends string> = string extends SId
  ? undefined
  : Style<H>;

export interface GeneratorSpec<V, H, SId extends string, P extends ParamSpecs>
  extends GeneratorBase<V, ActiveStyle<H, SId>> {
  params: P;
  /** The styles to choose from (made with styleFor). A "Style" dropdown of them is added to the params, first. */
  styles?: readonly Style<H, SId>[];
}

/** Hook names: the functions on a style. */
const hooksOf = (s: object): string[] =>
  Object.entries(s)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k);
/** The styles a generator was defined with, so later registered styles are checked against those alone. */
const OWN = new WeakMap<object, readonly object[]>();
/**
 * A style registered later must have every hook of at least one of the generator's own styles (a trees style needs
 * draw; a structures style needs row, or item), so it cannot fail deep inside render. Throws a clear error otherwise.
 */
export function checkStyle(g: AnyGenerator, s: StyleInfo): void {
  const own = OWN.get(g.styles ?? {}) ?? Object.values(g.styles ?? {});
  if (!own.length) {
    return;
  }
  const has = new Set(hooksOf(s));
  const sets = own.map((o) => hooksOf(o));
  if (sets.some((hooks) => hooks.every((h) => has.has(h)))) {
    return;
  }
  // name only the smallest sets: a style with every hook of one of them is enough
  const minimal = sets.filter(
    (hooks) =>
      !sets.some(
        (other) =>
          other.length < hooks.length && other.every((h) => hooks.includes(h))
      )
  );
  const options = [
    ...new Set(
      minimal.map((hooks) => hooks.map((h) => `"${h}"`).join(" and "))
    ),
  ];
  throw new Error(
    `Style "${s.id}" for ${g.id} needs ${options.join(", or ")}, like the ${g.id} styles. See the generator's hooks.ts.`
  );
}

/** Check a generator's styles, and add the style dropdown as its first param. */
function attachStyles<H>(g: AnyGenerator, styles: readonly Style<H>[]): void {
  const { id } = g;
  if (!(Array.isArray(styles) && styles.length)) {
    throw new Error(
      `Generator "${id}" has an empty styles list. Give it at least one style or leave styles out.`
    );
  }
  if (Object.hasOwn(g.params, "style")) {
    throw new Error(
      `Generator "${id}" has styles and its own "style" param. The style dropdown is added for you; remove the param.`
    );
  }
  g.styles = {};
  for (const s of styles) {
    if (!s?.isStyle) {
      throw new Error(
        `Generator "${id}": every entry in styles must come from a style factory (styleFor).`
      );
    }
    if (s.generator !== id) {
      throw new Error(
        `Style "${s.id}" belongs to "${s.generator}", not "${id}".`
      );
    }
    g.styles[s.id] = s;
  }
  OWN.set(g.styles, [...styles]);
  const sel: SelectSpec = {
    ...styleSelect("Style", styles[0]?.id ?? ""),
    labels: Object.fromEntries(styles.map((s) => [s.id, s.label ?? s.id])),
    options: styles.map((s) => s.id),
  };
  g.params = { style: sel, ...g.params };
}

/**
 * Declare a generator. Returns the generator object; register() makes it available to scenes.
 * With styles, a "Style" dropdown of them is added as the first param, and render gets the active one as c.style.
 */
export function defineGenerator<
  const Id extends string,
  const P extends ParamSpecs,
  H = object,
  SId extends string = string,
>(
  id: Id,
  spec: GeneratorSpec<GeneratorValues<P, SId>, H, SId, P>
): Generator<GeneratorValues<P, SId>, Id, H, StoredValues<P, SId>> {
  if (!ID_RE.test(id)) {
    throw new Error(
      `Generator id "${id}" must be lowercase letters, digits and dashes.`
    );
  }
  if (!KINDS.includes(spec.kind)) {
    throw new Error(
      `Generator "${id}" needs kind: one of ${KINDS.join(", ")}.`
    );
  }
  if (typeof spec.render !== "function") {
    throw new Error(`Generator "${id}" needs a render(c) function.`);
  }
  const { styles, ...rest } = spec;
  const g = {
    id,
    parallax: 1,
    ...rest,
    params: { ...spec.params } as ParamSpecs,
  } as Generator<GeneratorValues<P, SId>, Id, H, StoredValues<P, SId>>;
  if (styles !== undefined) {
    attachStyles(g, styles as readonly Style<H>[]);
  }
  return g;
}

/**
 * The hooks a style passes in, checked strictly: a hook may not narrow its parameters (a draw(c) that expects more than
 * the generator passes is an error), which plain method signatures would allow.
 */
export type StyleSpec<H> = {
  [K in keyof H]: NonNullable<H[K]> extends (...args: infer A) => infer R
    ? (...args: A) => R
    : H[K];
} & { label?: string };

/** A style for a generator that has styles (styleFor makes these). H is the hook interface the generator documents. */
export function defineStyle<
  H extends object,
  const Id extends string = string,
  const G extends string = string,
>(generator: G, id: Id, spec: StyleSpec<H>): Style<H, Id, G> {
  if (!ID_RE.test(id)) {
    throw new Error(
      `Style id "${id}" must be lowercase letters, digits and dashes.`
    );
  }
  return { ...spec, generator, id, isStyle: true } as unknown as Style<
    H,
    Id,
    G
  >;
}

/**
 * A style factory for one generator, so style files get typed hooks and a typed id:
 *   export const treesStyle = styleFor<TreesHooks>('trees');
 *   export default treesStyle('pine', { label: 'Pine', draw(c, tree, K) { ... } });
 */
export const styleFor =
  <H extends object, const G extends string = string>(generator: G) =>
  <const Id extends string>(id: Id, spec: StyleSpec<H>): Style<H, Id, G> =>
    defineStyle<H, Id, G>(generator, id, spec);

/** The active style for params p (the first style when p names an unknown one). */
export function styleOf<H>(
  g: { styles?: Record<string, Style<H>>; id: string },
  p: object
): Style<H> {
  const { styles } = g;
  const id = String((p as Record<string, unknown>).style);
  const named = styles?.[id];
  if (named) {
    return named;
  }
  const [first] = Object.values(styles ?? {});
  if (!first) {
    throw new Error(`Generator "${g.id}" has no styles.`);
  }
  warnOnce(
    `${g.id} has no style "${id}": drawing "${first.id}". A style of your own has to be registered with registerStyle() first.`
  );
  return first;
}

/** The params of a generator as scene JSON stores them. */
export type ValuesOf<G> =
  G extends Generator<infer _V, string, infer _H, infer S> ? S : never;

/**
 * Copy of a generator with new param defaults (and optionally a new id and label). Used when ejecting with the studio's
 * current settings. The copy has its own id, so it is typed as a generator with a plain string id.
 */
export function withDefaults<G extends AnyGenerator>(
  g: G,
  values: Partial<ValuesOf<G>> = {},
  meta: { id?: string; label?: string } = {}
): Omit<G, "id" | "label"> & { readonly id: string; label: string } {
  if (meta.id !== undefined && !ID_RE.test(meta.id)) {
    throw new Error(
      `Generator id "${meta.id}" must be lowercase letters, digits and dashes.`
    );
  }
  const given = values as Record<string, unknown>;
  const params: ParamSpecs = {};
  for (const [k, s] of Object.entries(g.params)) {
    const copy = { ...s } as typeof s;
    if (Object.hasOwn(given, k)) {
      (copy as { def: unknown }).def = given[k];
    }
    if (copy.type === "select") {
      copy.options = [...copy.options];
    }
    params[k] = copy;
  }
  const copy = { ...g, ...meta, params };
  if (g.styles) {
    copy.styles = { ...g.styles };
    const own = OWN.get(g.styles);
    if (own) {
      OWN.set(copy.styles, own);
    }
  }
  return copy;
}
