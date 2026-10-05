/* Small DOM helpers the studio shares: element creation, escaping, debounce, number formatting. */

const ON_PREFIX = /^on/;
const TRAILING_DOT = /\.$/;
const TRAILING_ZEROS = /0+$/;

type Child =
  | Node
  | string
  | number
  | null
  | undefined
  | false
  | readonly Child[];
type Attrs = Record<
  string,
  string | number | boolean | null | undefined | ((ev: Event) => void)
>;

/** Create an element: h("button", { class: "btn", onclick: fn }, "Label", icon). */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) {
      continue;
    }
    if (typeof v === "function") {
      el.addEventListener(k.replace(ON_PREFIX, ""), v as EventListener);
    } else if (k === "class") {
      el.className = String(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) {
      continue;
    }
    if (Array.isArray(c)) {
      append(el, c);
    } else if (typeof c === "string" || typeof c === "number") {
      el.append(String(c));
    } else {
      el.append(c as Node);
    }
  }
}

/** Parse trusted markup (icons, static chunks) into one element. */
export function html(markup: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as HTMLElement;
}

const ENTITIES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
export const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

export function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
export const lerp = (a: number, b: number, t: number): number =>
  a + (b - a) * t;

/** The value of the first rule whose condition holds, else `otherwise`: `a ? x : b ? y : z` without the nesting.
 * Every value is evaluated, so only pass cheap, side-effect free ones. */
export function choose<T>(
  rules: readonly (readonly [condition: boolean, value: T])[],
  otherwise: T
): T {
  for (const [condition, value] of rules) {
    if (condition) {
      return value;
    }
  }
  return otherwise;
}

/** Run a promise whose result nobody waits for: a failure is reported like any uncaught error instead of vanishing. */
export function fire(task: Promise<unknown>): void {
  task.catch((e: unknown) => {
    if (typeof reportError === "function") {
      reportError(e);
    } else {
      throw e;
    }
  });
}

/** Force the browser to lay the element out now, so a CSS animation class added next restarts from the beginning. */
export function reflow(el: HTMLElement): number {
  return el.offsetWidth;
}

export function debounce<A extends unknown[]>(
  fn: (...a: A) => void,
  ms: number
): ((...a: A) => void) & { cancel: () => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last: A | null = null;
  const run = () => {
    timer = undefined;
    if (last) {
      const a = last;
      last = null;
      fn(...a);
    }
  };
  const d = (...a: A) => {
    last = a;
    clearTimeout(timer);
    timer = setTimeout(run, ms);
  };
  d.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
    last = null;
  };
  d.flush = () => {
    clearTimeout(timer);
    run();
  };
  return d;
}

/** mm:ss.mmm */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, "0")}:${rest.toFixed(3).padStart(6, "0")}`;
}

export function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) {
    return "-";
  }
  const s = v.toFixed(digits);
  return s.includes(".")
    ? s.replace(TRAILING_ZEROS, "").replace(TRAILING_DOT, "")
    : s;
}

export const reducedMotion = (): boolean =>
  typeof matchMedia === "function" &&
  matchMedia("(prefers-reduced-motion: reduce)").matches;

export function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Per-viewer conveniences (a collapsed section, the last tab) live in localStorage when it works. */
export const prefs = {
  get<T>(key: string, dflt: T): T {
    return safe(() => {
      const raw = localStorage.getItem(`bleepkit:${key}`);
      return raw === null ? dflt : (JSON.parse(raw) as T);
    }, dflt);
  },
  set(key: string, value: unknown): void {
    safe(
      () => localStorage.setItem(`bleepkit:${key}`, JSON.stringify(value)),
      undefined
    );
  },
};
