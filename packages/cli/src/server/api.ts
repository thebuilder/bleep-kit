// The studio server's HTTP API (architecture.md 6.3). One handler, plain node:http, JSON in and out.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { runExport } from "../exporter.ts";
import { CliError, type ErrorCode } from "../output.ts";
import {
  DOC_KINDS,
  docRel,
  etagOf,
  KIND_DIRS,
  loadProjectFile,
  normalizeDocument,
  openProjectRoot,
  resolveRef,
  serializeDoc,
  writeFileAtomic,
} from "../project.ts";
import { type RenderOpts, renderDoc } from "../render.ts";
import { normalizeProject } from "../stubs.ts";
import type { Hub } from "./hub.ts";
import {
  type Classified,
  classify,
  cleanRelPath,
  contentType,
  insideRoot,
} from "./paths.ts";

const MAX_BODY = 16 * 1024 * 1024;
const INLINE_JSON_LIMIT = 256 * 1024;

export interface ApiState {
  hub: Hub;
  /** Last etag broadcast per path (null = broadcast as deleted); the watcher uses it to avoid duplicates. */
  known: Map<string, string | null>;
  root: string;
  version: string;
}

export interface FileEntry {
  etag: string;
  kind: Classified["kind"];
  mtime: number;
  path: string;
  size: number;
}

const HTTP_STATUS: Record<ErrorCode, number> = {
  bind: 500,
  encode: 500,
  invalid: 422,
  "no-project": 500,
  "not-found": 404,
  usage: 400,
  write: 500,
};

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

export class HttpError extends Error {
  readonly body: Record<string, unknown>;
  readonly status: number;

  constructor(
    status: number,
    error: string,
    message: string,
    extra: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.status = status;
    this.body = { error, message, ...extra };
  }
}

/* ---------- responses ---------- */

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(text),
    "content-type": "application/json; charset=utf-8",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) {
      throw new HttpError(
        413,
        "too-large",
        `request body is larger than ${MAX_BODY / 1024 / 1024} MB`
      );
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new HttpError(
      400,
      "bad-json",
      `request body is not valid JSON: ${(error as Error).message}`,
      {},
      error
    );
  }
}

function asObject(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  throw new HttpError(400, "bad-request", "request body must be a JSON object");
}

/* ---------- files ---------- */

const etagCache = new Map<
  string,
  { etag: string; mtimeMs: number; size: number }
>();

export function fileEtag(abs: string, stat: fs.Stats): string {
  const hit = etagCache.get(abs);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return hit.etag;
  }
  const etag = etagOf(fs.readFileSync(abs));
  etagCache.set(abs, { etag, mtimeMs: stat.mtimeMs, size: stat.size });
  return etag;
}

function allowedPath(
  root: string,
  raw: string | null
): { abs: string; cls: Classified; rel: string } {
  const rel = cleanRelPath(raw);
  if (!rel) {
    throw new HttpError(
      403,
      "forbidden",
      `path "${raw ?? ""}" is not allowed: use a project relative path like sfx/coin.json`
    );
  }
  const cls = classify(rel);
  if (!cls) {
    throw new HttpError(
      403,
      "forbidden",
      `path "${rel}" is not allowed: only project.json, sfx/*.json, instruments/*.json, songs/*.json and out/** can be accessed`
    );
  }
  return { abs: path.join(root, rel), cls, rel };
}

function walk(root: string, rel: string, out: FileEntry[]): void {
  const abs = path.join(root, rel);
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    if (d.name.startsWith(".")) {
      continue;
    }
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) {
      walk(root, childRel, out);
    } else {
      const cls = classify(childRel);
      if (cls) {
        const full = path.join(root, childRel);
        const stat = fs.statSync(full);
        out.push({
          etag: fileEtag(full, stat),
          kind: cls.kind,
          mtime: stat.mtimeMs,
          path: childRel,
          size: stat.size,
        });
      }
    }
  }
}

export function listFiles(root: string): FileEntry[] {
  const out: FileEntry[] = [];
  const projectFile = path.join(root, "project.json");
  if (fs.existsSync(projectFile)) {
    const stat = fs.statSync(projectFile);
    out.push({
      etag: fileEtag(projectFile, stat),
      kind: "project",
      mtime: stat.mtimeMs,
      path: "project.json",
      size: stat.size,
    });
  }
  for (const dir of Object.values(KIND_DIRS)) {
    walk(root, dir, out);
  }
  walk(root, "out", out);
  return out;
}

/** The websocket `file` message for a path that exists on disk. */
export function fileMessage(
  root: string,
  rel: string
): {
  etag: string;
  json?: unknown;
  mtime: number;
  path: string;
  type: "file";
} | null {
  const cls = classify(rel);
  const abs = path.join(root, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!(cls && stat.isFile())) {
    return null;
  }
  const etag = fileEtag(abs, stat);
  const msg: {
    etag: string;
    json?: unknown;
    mtime: number;
    path: string;
    type: "file";
  } = {
    etag,
    mtime: stat.mtimeMs,
    path: rel,
    type: "file",
  };
  if (cls.kind !== "render" && stat.size < INLINE_JSON_LIMIT) {
    try {
      msg.json = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      // half written or invalid: the client fetches it when it wants it
    }
  }
  return msg;
}

function serveRaw(
  req: IncomingMessage,
  res: ServerResponse,
  abs: string,
  etag: string,
  size: number
): void {
  const type = contentType(abs);
  const range = RANGE_RE.exec(req.headers.range ?? "");
  const headers: Record<string, string | number> = {
    "accept-ranges": "bytes",
    "cache-control": "no-cache",
    "content-type": type,
    etag: `"${etag}"`,
  };
  if (range) {
    const start =
      range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end =
      range[1] === "" || range[2] === ""
        ? size - 1
        : Math.min(size - 1, Number(range[2]));
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...headers,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
    });
    fs.createReadStream(abs, { end, start }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  fs.createReadStream(abs).pipe(res);
}

function getFile(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): void {
  const { abs, rel } = allowedPath(state.root, url.searchParams.get("path"));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch (error) {
    throw new HttpError(404, "not-found", `${rel} does not exist`, {}, error);
  }
  if (!(stat.isFile() && insideRoot(state.root, abs))) {
    throw new HttpError(
      stat.isFile() ? 403 : 404,
      stat.isFile() ? "forbidden" : "not-found",
      `${rel} is not readable`
    );
  }
  const etag = fileEtag(abs, stat);
  const wantRaw = url.searchParams.get("raw") === "1";
  if (abs.endsWith(".json") && !wantRaw) {
    let json: unknown;
    try {
      json = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch (error) {
      throw new HttpError(
        422,
        "invalid-json",
        `${rel} is not valid JSON: ${(error as Error).message}`,
        { etag },
        error
      );
    }
    sendJson(res, 200, { etag, json, mtime: stat.mtimeMs, path: rel });
    return;
  }
  serveRaw(req, res, abs, etag, stat.size);
}

async function putFile(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const { abs, cls, rel } = allowedPath(
    state.root,
    url.searchParams.get("path")
  );
  if (cls.kind === "render") {
    throw new HttpError(
      403,
      "forbidden",
      `${rel} is a render: renders are written by \`render\`, not saved`
    );
  }
  const body = asObject(await readBody(req));
  if (!("json" in body)) {
    throw new HttpError(
      400,
      "bad-request",
      'body must be { "json": <document>, "ifMatch"?: <etag> }'
    );
  }
  const ifMatch = typeof body.ifMatch === "string" ? body.ifMatch : null;
  let currentEtag: string | null = null;
  try {
    currentEtag = fileEtag(abs, fs.statSync(abs));
  } catch {
    currentEtag = null;
  }
  if (ifMatch !== null && ifMatch !== currentEtag) {
    let current: unknown = null;
    try {
      current = JSON.parse(fs.readFileSync(abs, "utf8"));
    } catch {
      current = null;
    }
    sendJson(res, 412, {
      error: "conflict",
      etag: currentEtag,
      json: current,
      message: `${rel} changed on disk since you loaded it`,
    });
    return;
  }
  const pc = openProjectRoot(state.root, undefined, { lenient: true });
  const n =
    cls.kind === "project"
      ? normalizeProject(body.json)
      : normalizeDocument(
          cls.docKind ?? "sfx",
          body.json,
          cls.docKind === "song" ? pc.instruments() : undefined
        );
  if (!n.ok) {
    sendJson(res, 422, {
      error: "invalid",
      issues: n.issues,
      message: `${rel} has errors: ${n.issues
        .filter((i) => i.severity === "error")
        .map((i) => `${i.path || "/"} ${i.message}`)
        .join("; ")}`,
    });
    return;
  }
  writeFileAtomic(abs, serializeDoc(n.value));
  const stat = fs.statSync(abs);
  const etag = fileEtag(abs, stat);
  const msg = fileMessage(state.root, rel);
  state.known.set(rel, etag);
  if (msg) {
    state.hub.broadcast(msg);
  }
  sendJson(res, 200, {
    etag,
    issues: n.issues,
    json: n.value,
    mtime: stat.mtimeMs,
    ok: true,
    path: rel,
  });
}

function deleteFile(state: ApiState, url: URL, res: ServerResponse): void {
  const { abs, cls, rel } = allowedPath(
    state.root,
    url.searchParams.get("path")
  );
  if (cls.kind === "project") {
    throw new HttpError(403, "forbidden", "project.json cannot be deleted");
  }
  if (!fs.existsSync(abs)) {
    throw new HttpError(404, "not-found", `${rel} does not exist`);
  }
  fs.rmSync(abs, { force: true });
  etagCache.delete(abs);
  state.known.set(rel, null);
  state.hub.broadcast({ path: rel, type: "deleted" });
  sendJson(res, 200, { ok: true, path: rel });
}

/* ---------- actions ---------- */

function renderOptions(raw: unknown): RenderOpts {
  const o =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: RenderOpts = {};
  for (const flag of [
    "analyze",
    "force",
    "images",
    "pitch",
    "stems",
  ] as const) {
    if (o[flag] === true) {
      out[flag] = true;
    }
  }
  if (o.format === "wav" || o.format === "ogg" || o.format === "mp3") {
    out.format = o.format;
  }
  for (const num of ["loops", "rate", "tail", "window"] as const) {
    if (typeof o[num] === "number") {
      out[num] = o[num];
    }
  }
  return out;
}

function failure(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof CliError) {
    return new HttpError(HTTP_STATUS[error.code], error.code, error.message, {
      ...(error.hint ? { hint: error.hint } : {}),
      ...error.details,
    });
  }
  return new HttpError(500, "internal", (error as Error).message);
}

async function postRender(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readBody(req));
  const refText = typeof body.ref === "string" ? body.ref : null;
  if (!refText) {
    throw new HttpError(
      400,
      "bad-request",
      'body must be { "ref": "sfx/coin", "options"?: {...} }'
    );
  }
  const pc = openProjectRoot(state.root);
  let ref: ReturnType<typeof resolveRef>;
  try {
    ref = resolveRef(pc, refText, ["sfx", "song"]);
  } catch (error) {
    throw failure(error);
  }
  state.hub.broadcast({ ref: ref.ref, status: "started", type: "render" });
  await new Promise((r) => setImmediate(r));
  try {
    const entry = await renderDoc(
      pc,
      ref.kind as "sfx" | "song",
      ref.id,
      renderOptions(body.options)
    );
    state.hub.broadcast({
      ref: ref.ref,
      result: entry,
      status: "done",
      type: "render",
    });
    sendJson(res, 200, entry);
  } catch (error) {
    const f = failure(error);
    state.hub.broadcast({
      ref: ref.ref,
      result: f.body,
      status: "failed",
      type: "render",
    });
    throw f;
  }
}

async function postAnalyze(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readBody(req));
  const refText = typeof body.ref === "string" ? body.ref : null;
  if (!refText) {
    throw new HttpError(
      400,
      "bad-request",
      'body must be { "ref": "sfx/coin" }'
    );
  }
  const pc = openProjectRoot(state.root);
  try {
    const ref = resolveRef(pc, refText, ["sfx", "song"]);
    const entry = await renderDoc(pc, ref.kind as "sfx" | "song", ref.id, {
      ...renderOptions(body),
      analyze: true,
    });
    sendJson(res, 200, { ...entry.analysis, ok: true, ref: ref.ref });
  } catch (error) {
    throw failure(error);
  }
}

async function postExport(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readBody(req));
  try {
    const pc = openProjectRoot(state.root);
    const result = await runExport(pc, { dryRun: body.dryRun === true });
    sendJson(res, 200, result);
  } catch (error) {
    throw failure(error);
  }
}

async function postPlay(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = asObject(await readBody(req));
  const refText = typeof body.ref === "string" ? body.ref : null;
  if (!refText) {
    throw new HttpError(
      400,
      "bad-request",
      'body must be { "ref": "sfx/coin", "visual"?: boolean }'
    );
  }
  let canonical: string;
  try {
    canonical = resolveRef(openProjectRoot(state.root), refText, [
      ...DOC_KINDS,
    ]).ref;
  } catch (error) {
    throw failure(error);
  }
  state.hub.broadcast({
    ref: canonical,
    type: "play",
    visual: body.visual === true,
  });
  sendJson(res, 200, { clients: state.hub.count(), ok: true, ref: canonical });
}

/* ---------- router ---------- */

export async function handleApi(
  state: ApiState,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const route = url.pathname;
  const method = req.method ?? "GET";
  try {
    if (route === "/api/health" && method === "GET") {
      sendJson(res, 200, {
        ok: true,
        root: state.root,
        version: state.version,
      });
      return;
    }
    if (route === "/api/project" && method === "GET") {
      let loaded: ReturnType<typeof loadProjectFile>;
      try {
        loaded = loadProjectFile(state.root);
      } catch (error) {
        throw failure(error);
      }
      sendJson(res, 200, {
        files: listFiles(state.root),
        issues: loaded.issues,
        project: loaded.project,
        root: state.root,
      });
      return;
    }
    if (route === "/api/file") {
      if (method === "GET") {
        getFile(state, req, res, url);
        return;
      }
      if (method === "PUT") {
        await putFile(state, req, res, url);
        return;
      }
      if (method === "DELETE") {
        deleteFile(state, url, res);
        return;
      }
      throw new HttpError(
        405,
        "method-not-allowed",
        `${method} is not supported on /api/file (use GET, PUT or DELETE)`
      );
    }
    const posts: Record<
      string,
      (s: ApiState, q: IncomingMessage, r: ServerResponse) => Promise<void>
    > = {
      "/api/analyze": postAnalyze,
      "/api/export": postExport,
      "/api/play": postPlay,
      "/api/render": postRender,
    };
    const post = posts[route];
    if (post) {
      if (method !== "POST") {
        throw new HttpError(405, "method-not-allowed", `${route} takes POST`);
      }
      await post(state, req, res);
      return;
    }
    throw new HttpError(
      404,
      "not-found",
      `no such API route: ${method} ${route}`
    );
  } catch (error) {
    const f = failure(error);
    if (res.headersSent) {
      res.end();
    } else {
      sendJson(res, f.status, f.body);
    }
  }
}

export { docRel };
