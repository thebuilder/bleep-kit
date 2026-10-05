/* Runtime registry. Scenes refer to generators by id; register() and registerStyle() add built-in, ejected or custom modules.
   GEN has no prototype, so ids like "constructor" or "__proto__" are simply unknown. */
import { checkStyle } from "./define.ts";
import type { AnyGenerator, Style } from "./types.ts";

export const GEN: Record<string, AnyGenerator> = Object.create(null);

/** Add or replace a generator. */
export function register<G extends AnyGenerator>(g: G): G {
  GEN[g.id] = g;
  return g;
}

/** Add or replace a style on a registered generator. The style shows up in that generator's style dropdown. */
export function registerStyle<S extends Style>(s: S): S {
  const g = Object.hasOwn(GEN, s.generator) ? GEN[s.generator] : undefined;
  if (!g) {
    throw new Error(`No generator "${s.generator}" to add style "${s.id}" to.`);
  }
  if (!g.styles) {
    throw new Error(`Generator "${s.generator}" does not take styles.`);
  }
  checkStyle(g, s);
  g.styles[s.id] = s;
  g.version = (g.version ?? 0) + 1; // invalidates cached renders that used the old style
  const ps = g.params.style;
  if (ps?.type === "select") {
    if (!ps.options.includes(s.id)) {
      ps.options.push(s.id);
    }
    ps.labels = { ...ps.labels, [s.id]: s.label ?? s.id };
  }
  return s;
}
