// Project folder discovery and document IO. The CLI is the only package that touches the file system, so everything
// that reads or writes a project folder lives here (the studio server and the commands share it).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CliError, type Ctx, closest } from "./output.ts";
import {
  type Instrument,
  type Issue,
  normalizeInstrument,
  normalizeProject,
  normalizeSfx,
  normalizeSong,
  type Project,
  type Sfx,
  type Song,
} from "./stubs.ts";

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const DOC_KINDS = ["sfx", "song", "instrument"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Folder (and ref prefix) of each document kind inside the project folder. */
export const KIND_DIRS: Record<DocKind, string> = {
  instrument: "instruments",
  sfx: "sfx",
  song: "songs",
};

export interface DocValue {
  instrument: Instrument;
  sfx: Sfx;
  song: Song;
}

/* ---------- small fs helpers ---------- */

export function sha1Hex(data: string | Uint8Array): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

/** Etag = sha1 of the file bytes, 12 hex chars (architecture.md 6.3). */
export function etagOf(bytes: Uint8Array): string {
  return sha1Hex(bytes).slice(0, 12);
}

/** Writes to a temp file in the same folder, then renames over the target, so readers never see half a file. */
export function writeFileAtomic(abs: string, data: string | Uint8Array): void {
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(abs)}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, abs);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new CliError(
      "write",
      `could not write ${abs}: ${(error as Error).message}`,
      { cause: error, hint: "Check that the folder exists and is writable." }
    );
  }
}

/** JSON with sorted keys, so equal documents hash equally whatever their key order. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  // JSON.stringify returns undefined for undefined, functions and symbols
  // biome-ignore lint/suspicious/noUnnecessaryConditions: the type lies
  return JSON.stringify(value) ?? "null";
}

/** The text written to disk for a document: pretty JSON, no `id` (the file name is the id). */
export function serializeDoc(value: unknown): string {
  const copy = { ...(value as Record<string, unknown>) };
  copy.id = undefined;
  return `${JSON.stringify(copy, null, 2)}\n`;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/* ---------- discovery ---------- */

interface ProjectProbe {
  dir: string;
}

function probe(dir: string): ProjectProbe | null {
  const file = path.join(dir, "project.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.version === "number" &&
      ("chip" in parsed || "export" in parsed)
    ) {
      return { dir };
    }
  } catch {
    // not a project folder
  }
  return null;
}

export function findProjectDir(ctx: Ctx, explicit?: string): string {
  const flag = explicit ?? ctx.projectFlag;
  if (flag !== undefined) {
    let dir = path.resolve(ctx.cwd, flag);
    if (path.basename(dir) === "project.json") {
      dir = path.dirname(dir);
    }
    if (fs.existsSync(path.join(dir, "project.json"))) {
      return dir;
    }
    const nested = path.join(dir, "audio");
    throw new CliError("no-project", `no project.json in ${dir}`, {
      hint: fs.existsSync(path.join(nested, "project.json"))
        ? `Found one in ${nested}: use --project ${nested}`
        : `Create one with: bleepkit init ${flag}`,
    });
  }
  let dir = ctx.cwd;
  for (;;) {
    const direct = probe(dir);
    if (direct) {
      return direct.dir;
    }
    const nested = probe(path.join(dir, "audio"));
    if (nested) {
      return nested.dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new CliError(
    "no-project",
    `no Bleepkit project found from ${ctx.cwd}`,
    {
      hint: "Run `bleepkit init` to create ./audio, or pass --project <dir> (the folder that holds project.json).",
    }
  );
}

/* ---------- the open project ---------- */

export interface ProjectCtx {
  /** All instruments, normalized (cached per run). */
  instruments: () => Record<string, Instrument>;
  issues: Issue[];
  project: Project;
  /** Forget cached documents (the server calls this when files change). */
  reset: () => void;
  /** Absolute project folder. */
  root: string;
  /** The seed for this run: --seed, else project.seed. */
  seed: number;
}

export function readJsonFile(abs: string, rel: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CliError(
      code === "ENOENT" ? "not-found" : "write",
      `cannot read ${rel}: ${(error as Error).message}`,
      { cause: error }
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(
      "invalid",
      `${rel} is not valid JSON: ${(error as Error).message}`,
      {
        cause: error,
        hint: "Fix the syntax (trailing commas and comments are not allowed in JSON) or regenerate the file.",
      }
    );
  }
}

export function loadProjectFile(root: string): {
  issues: Issue[];
  ok: boolean;
  project: Project;
} {
  const rel = "project.json";
  let raw: unknown;
  try {
    raw = readJsonFile(path.join(root, rel), rel);
  } catch (error) {
    if (error instanceof CliError && error.code === "invalid") {
      throw new CliError(
        "no-project",
        error.message,
        error.hint ? { cause: error, hint: error.hint } : { cause: error }
      );
    }
    throw error;
  }
  const n = normalizeProject(raw);
  return { issues: n.issues, ok: n.ok, project: n.value };
}

export interface OpenOptions {
  /** Do not throw when project.json has errors (validate reports them instead). */
  lenient?: boolean;
}

export function openProject(
  ctx: Ctx,
  options: OpenOptions = {},
  explicit?: string
): ProjectCtx {
  return openProjectRoot(findProjectDir(ctx, explicit), ctx.seed, options);
}

/** Opens the project in a known folder (the studio server uses this once per request). */
export function openProjectRoot(
  root: string,
  seed?: number,
  options: OpenOptions = {}
): ProjectCtx {
  const loaded = loadProjectFile(root);
  if (!(loaded.ok || options.lenient)) {
    const lines = loaded.issues
      .filter((i) => i.severity === "error")
      .map((i) => `  ${i.path || "/"}: ${i.message}`);
    throw new CliError(
      "invalid",
      `project.json has errors:\n${lines.join("\n")}`,
      {
        details: { issues: loaded.issues },
        hint: "Fix project.json (see `bleepkit help formats project`) and run `bleepkit validate`.",
      }
    );
  }
  let cache: Record<string, Instrument> | null = null;
  return {
    instruments: () => {
      cache ??= loadAllInstruments(root);
      return cache;
    },
    issues: loaded.issues,
    project: loaded.project,
    reset: () => {
      cache = null;
    },
    root,
    seed: seed ?? loaded.project.seed,
  };
}

/* ---------- documents ---------- */

export function docRel(kind: DocKind, id: string): string {
  return `${KIND_DIRS[kind]}/${id}.json`;
}

export function listIds(root: string, kind: DocKind): string[] {
  const dir = path.join(root, KIND_DIRS[kind]);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && !n.startsWith("."))
    .map((n) => n.slice(0, -5))
    .sort();
}

export function listIdsValid(root: string, kind: DocKind): string[] {
  return listIds(root, kind).filter((id) => ID_PATTERN.test(id));
}

export function normalizeDocument(
  kind: DocKind,
  raw: unknown,
  instruments?: Record<string, Instrument>
) {
  if (kind === "sfx") {
    return normalizeSfx(raw);
  }
  if (kind === "instrument") {
    return normalizeInstrument(raw);
  }
  return normalizeSong(raw, instruments);
}

function loadAllInstruments(root: string): Record<string, Instrument> {
  const out: Record<string, Instrument> = {};
  for (const id of listIdsValid(root, "instrument")) {
    try {
      const raw = readJsonFile(
        path.join(root, docRel("instrument", id)),
        docRel("instrument", id)
      );
      out[id] = normalizeInstrument(raw).value;
    } catch {
      // reported by `validate`; a song that needs it gets "unknown instrument"
    }
  }
  return out;
}

export interface LoadedDoc<K extends DocKind = DocKind> {
  abs: string;
  id: string;
  issues: Issue[];
  kind: K;
  mtimeMs: number;
  ok: boolean;
  raw: unknown;
  ref: string;
  rel: string;
  value: DocValue[K];
}

export function checkId(id: string, what = "id"): void {
  if (!ID_PATTERN.test(id)) {
    throw new CliError(
      "usage",
      `invalid ${what} "${id}": use lowercase letters, digits and dashes, starting with a letter or digit (max 64)`,
      {
        hint: `Example: ${
          id
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "coin-2"
        }`,
      }
    );
  }
}

export function loadDoc<K extends DocKind>(
  pc: ProjectCtx,
  kind: K,
  id: string
): LoadedDoc<K> {
  checkId(id);
  const rel = docRel(kind, id);
  const abs = path.join(pc.root, rel);
  if (!fs.existsSync(abs)) {
    const ids = listIdsValid(pc.root, kind);
    const guess = closest(id, ids);
    throw new CliError(
      "not-found",
      `${kind}/${id} not found (expected ${rel} in ${pc.root})`,
      {
        hint: guess
          ? `Did you mean ${kind}/${guess}? Run \`bleepkit list ${KIND_DIRS[kind]}\` to see what exists.`
          : `Run \`bleepkit list ${KIND_DIRS[kind]}\` to see what exists, or create it with \`bleepkit new ${kind} ${id}\`.`,
      }
    );
  }
  const raw = readJsonFile(abs, rel);
  const n = normalizeDocument(
    kind,
    raw,
    kind === "song" ? pc.instruments() : undefined
  );
  return {
    abs,
    id,
    issues: n.issues,
    kind,
    mtimeMs: fs.statSync(abs).mtimeMs,
    ok: n.ok,
    raw,
    ref: `${kind}/${id}`,
    rel,
    value: n.value as DocValue[K],
  };
}

/** Throws an `invalid` error listing the error issues when the document did not normalize cleanly. */
export function requireOk(doc: {
  issues: Issue[];
  ok: boolean;
  ref: string;
  rel: string;
}): void {
  if (doc.ok) {
    return;
  }
  const errors = doc.issues.filter((i) => i.severity === "error");
  const lines = errors.map((i) => `  ${i.path || "/"}: ${i.message}`);
  throw new CliError(
    "invalid",
    `${doc.ref} has ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${lines.join("\n")}`,
    {
      details: { issues: doc.issues, ref: doc.ref },
      hint: `Edit ${doc.rel} and run \`bleepkit validate ${doc.ref}\` until it passes.`,
    }
  );
}

export function writeDoc(
  pc: ProjectCtx,
  kind: DocKind,
  id: string,
  value: unknown
): string {
  const rel = docRel(kind, id);
  writeFileAtomic(path.join(pc.root, rel), serializeDoc(value));
  pc.reset();
  return rel;
}

/* ---------- refs ---------- */

const KIND_ALIASES: Record<string, DocKind> = {
  instrument: "instrument",
  instruments: "instrument",
  sfx: "sfx",
  song: "song",
  songs: "song",
};

export interface ParsedRef {
  id: string;
  kind: DocKind | null;
}

const BACKSLASH_RE = /\\/g;
const JSON_EXT_RE = /\.json$/;

export function parseRef(ref: string): ParsedRef {
  const cleaned = ref.replace(BACKSLASH_RE, "/").replace(JSON_EXT_RE, "");
  const slash = cleaned.indexOf("/");
  if (slash === -1) {
    checkId(cleaned, "document id");
    return { id: cleaned, kind: null };
  }
  const prefix = cleaned.slice(0, slash);
  const kind = KIND_ALIASES[prefix];
  if (!kind) {
    throw new CliError(
      "usage",
      `unknown document kind "${prefix}" in reference "${ref}"`,
      {
        hint: "Use sfx/<id>, song/<id> or instrument/<id>, for example sfx/coin.",
      }
    );
  }
  const id = cleaned.slice(slash + 1);
  checkId(id, "document id");
  return { id, kind };
}

export interface ResolvedRef {
  id: string;
  kind: DocKind;
  ref: string;
}

/** Resolves a user reference to a kind and id. A bare id looks in `kinds` in order and must match exactly one. */
export function resolveRef(
  pc: ProjectCtx,
  ref: string,
  kinds: readonly DocKind[]
): ResolvedRef {
  const parsed = parseRef(ref);
  if (parsed.kind) {
    if (!kinds.includes(parsed.kind)) {
      throw new CliError(
        "usage",
        `this command does not take ${parsed.kind} documents (got "${ref}")`,
        { hint: `Use one of: ${kinds.map((k) => `${k}/<id>`).join(", ")}.` }
      );
    }
    if (!listIds(pc.root, parsed.kind).includes(parsed.id)) {
      const guess = closest(parsed.id, listIdsValid(pc.root, parsed.kind));
      throw new CliError(
        "not-found",
        `no ${parsed.kind} "${parsed.id}" in ${pc.root} (expected ${docRel(parsed.kind, parsed.id)})`,
        {
          hint: guess
            ? `Did you mean ${parsed.kind}/${guess}? Run \`bleepkit list ${KIND_DIRS[parsed.kind]}\` to see what exists.`
            : `Run \`bleepkit list ${KIND_DIRS[parsed.kind]}\` to see what exists, or create it with \`bleepkit new ${parsed.kind} ${parsed.id}\`.`,
        }
      );
    }
    return {
      id: parsed.id,
      kind: parsed.kind,
      ref: `${parsed.kind}/${parsed.id}`,
    };
  }
  const found = kinds.filter((k) => listIds(pc.root, k).includes(parsed.id));
  if (found.length === 1 && found[0]) {
    return { id: parsed.id, kind: found[0], ref: `${found[0]}/${parsed.id}` };
  }
  if (found.length > 1) {
    throw new CliError(
      "usage",
      `"${ref}" is ambiguous: it exists as ${found.map((k) => `${k}/${parsed.id}`).join(" and ")}`,
      {
        hint: `Say which: ${found.map((k) => `${k}/${parsed.id}`).join(" or ")}.`,
      }
    );
  }
  const all = kinds.flatMap((k) =>
    listIdsValid(pc.root, k).map((id) => `${k}/${id}`)
  );
  const guess =
    closest(`${kinds[0]}/${parsed.id}`, all) ??
    closest(
      parsed.id,
      all.map((a) => a.split("/")[1] ?? a)
    );
  throw new CliError("not-found", `no document "${ref}" in ${pc.root}`, {
    hint: guess
      ? `Did you mean ${guess.includes("/") ? guess : `${kinds[0]}/${guess}`}? Run \`bleepkit list\` to see everything.`
      : "Run `bleepkit list` to see what exists.",
  });
}

/** Every instrument id a song uses: channel defaults, row `inst` fields and MML `@id` switches. */
export function referencedInstruments(song: Song): string[] {
  const ids = new Set<string>();
  for (const channel of song.channels) {
    if (channel.instrument) {
      ids.add(channel.instrument);
    }
    if (channel.mml) {
      for (const m of channel.mml.matchAll(/@([A-Za-z0-9-]+)/g)) {
        if (m[1]) {
          ids.add(m[1]);
        }
      }
    }
  }
  for (const pattern of Object.values(song.patterns)) {
    for (const rows of Object.values(pattern.tracks)) {
      for (const row of rows) {
        if (row.inst) {
          ids.add(row.inst);
        }
      }
    }
  }
  return [...ids].sort();
}

export function instrumentsFor(
  pc: ProjectCtx,
  song: Song
): Record<string, Instrument> {
  const all = pc.instruments();
  const out: Record<string, Instrument> = {};
  for (const id of referencedInstruments(song)) {
    const inst = all[id];
    if (inst) {
      out[id] = inst;
    }
  }
  return out;
}
