// JSON Pointer (RFC 6901) reads and edits on plain JSON, with error messages that say what is there instead.

export type Change =
  | { op: "set"; path: string; value: unknown }
  | { op: "remove"; path: string };

const INDEX_RE = /^(0|[1-9]\d*)$/;

function tokens(path: string): string[] | string {
  if (path === "") {
    return [];
  }
  if (!path.startsWith("/")) {
    return `"${path}" is not a JSON pointer: it must start with "/", like /channels/0/mml`;
  }
  return path
    .slice(1)
    .split("/")
    .map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
}

const describe = (v: unknown): string => {
  if (Array.isArray(v)) {
    return `an array of ${v.length}`;
  }
  if (v !== null && typeof v === "object") {
    const keys = Object.keys(v);
    return `an object with ${keys.length === 0 ? "no keys" : `keys ${keys.slice(0, 12).join(", ")}${keys.length > 12 ? ", ..." : ""}`}`;
  }
  return String(JSON.stringify(v));
};

type Walked =
  | { ok: true; parent: unknown; key: string }
  | { ok: false; error: string };

function walkToParent(root: unknown, toks: string[], path: string): Walked {
  let cur = root;
  for (const [i, t] of toks.slice(0, -1).entries()) {
    const next = step(cur, t);
    if (next === undefined) {
      return {
        error: `${path}: nothing at ${tokensToPath(toks.slice(0, i + 1))} (the parent is ${describe(cur)})`,
        ok: false,
      };
    }
    cur = next;
  }
  return { key: toks.at(-1) ?? "", ok: true, parent: cur };
}

const tokensToPath = (toks: string[]): string =>
  `/${toks.map((t) => t.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

function step(node: unknown, token: string): unknown {
  if (Array.isArray(node)) {
    return INDEX_RE.test(token) ? node[Number(token)] : undefined;
  }
  if (node !== null && typeof node === "object") {
    return (node as Record<string, unknown>)[token];
  }
  return undefined;
}

/** The value at a pointer, or the reason there is none. */
export function getAt(
  root: unknown,
  path: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  const toks = tokens(path);
  if (typeof toks === "string") {
    return { error: toks, ok: false };
  }
  let cur = root;
  for (const [i, t] of toks.entries()) {
    const next = step(cur, t);
    if (next === undefined) {
      return {
        error: `nothing at ${tokensToPath(toks.slice(0, i + 1))} (the parent is ${describe(cur)})`,
        ok: false,
      };
    }
    cur = next;
  }
  return { ok: true, value: cur };
}

function setIn(
  parent: unknown,
  key: string,
  value: unknown,
  path: string
): string | null {
  if (Array.isArray(parent)) {
    if (key === "-") {
      parent.push(value);
      return null;
    }
    const i = Number(key);
    if (!INDEX_RE.test(key) || i > parent.length) {
      return `${path}: index ${key} is outside the array (it has ${parent.length} items; use ${parent.length} or "-" to append)`;
    }
    parent[i] = value;
    return null;
  }
  if (parent !== null && typeof parent === "object") {
    (parent as Record<string, unknown>)[key] = value;
    return null;
  }
  return `${path}: the parent is ${describe(parent)}, not an object or array`;
}

function removeFrom(parent: unknown, key: string, path: string): string | null {
  if (Array.isArray(parent)) {
    const i = Number(key);
    if (!INDEX_RE.test(key) || i >= parent.length) {
      return `${path}: no item ${key} to remove (the array has ${parent.length} items)`;
    }
    parent.splice(i, 1);
    return null;
  }
  if (parent !== null && typeof parent === "object" && key in parent) {
    delete (parent as Record<string, unknown>)[key];
    return null;
  }
  return `${path}: nothing to remove (the parent is ${describe(parent)})`;
}

/** Apply the changes in order to a copy of `doc`. Fails on the first bad one, naming it, and returns nothing. */
export function applyChanges(
  doc: unknown,
  changes: readonly Change[]
): { ok: true; value: unknown } | { ok: false; error: string } {
  const copy = structuredClone(doc);
  for (const [n, change] of changes.entries()) {
    const label = `change ${n + 1} (${change.op} ${change.path})`;
    const toks = tokens(change.path);
    if (typeof toks === "string") {
      return { error: `${label}: ${toks}`, ok: false };
    }
    if (toks.length === 0) {
      return {
        error: `${label}: cannot change the whole document, use write_document`,
        ok: false,
      };
    }
    const walked = walkToParent(copy, toks, label);
    if (!walked.ok) {
      return { error: walked.error, ok: false };
    }
    const problem =
      change.op === "set"
        ? setIn(walked.parent, walked.key, structuredClone(change.value), label)
        : removeFrom(walked.parent, walked.key, label);
    if (problem) {
      return { error: problem, ok: false };
    }
  }
  return { ok: true, value: copy };
}
