/* The ProjectStore: how the studio reads and writes a project. `server.ts` talks to the CLI's studio server
   (section 6.3), `local.ts` keeps the same shapes in IndexedDB (section 6.5). Paths are always relative to the
   project folder, with forward slashes. */
import type { Issue, Project } from "../lib/contract.ts";

export type FileKind = "project" | "sfx" | "instrument" | "song" | "render";

export interface FileEntry {
  etag: string;
  kind: FileKind;
  mtime: number;
  path: string;
  size: number;
}

export interface ProjectInfo {
  files: FileEntry[];
  project: Project;
  root: string;
}

export interface FileJson {
  etag: string;
  json: unknown;
  mtime: number;
  path: string;
}

export type WriteResult =
  | { ok: true; etag: string; mtime: number }
  | { ok: false; reason: "conflict"; etag: string; json: unknown }
  | { ok: false; reason: "invalid"; issues: Issue[] }
  | { ok: false; reason: "error"; message: string };

export type ServerMessage =
  | { type: "hello"; root: string; project: Project }
  | { type: "file"; path: string; etag: string; mtime: number; json?: unknown }
  | { type: "deleted"; path: string }
  | { type: "play"; ref: string; visual: boolean }
  | {
      type: "render";
      ref: string;
      status: "started" | "done" | "failed";
      result?: unknown;
    }
  | { type: "log"; level: "info" | "warn" | "error"; message: string };

export interface ProjectStore {
  analyzeRemote?(ref: string): Promise<unknown>;
  close(): void;
  exportAll?(dryRun: boolean): Promise<unknown>;
  /** Short text for the status area: the folder on disk, or "this browser". */
  readonly label: string;
  list(): Promise<FileEntry[]>;
  readonly mode: "server" | "local";
  open(): Promise<ProjectInfo>;
  readBytes(path: string): Promise<Uint8Array | null>;
  readJson(path: string): Promise<FileJson>;
  remove(path: string): Promise<void>;
  /** Server only. */
  render?(ref: string, options?: Record<string, unknown>): Promise<unknown>;
  subscribe(fn: (msg: ServerMessage) => void): () => void;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Write a document; `ifMatch` is the etag the caller loaded, left out to overwrite. */
  writeJson(
    path: string,
    json: unknown,
    ifMatch?: string
  ): Promise<WriteResult>;
}

/** Document ids are file names without the extension. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function kindOfPath(path: string): FileKind | null {
  if (path === "project.json") {
    return "project";
  }
  const m = /^(sfx|instruments|songs)\/[^/]+\.json$/.exec(path);
  if (m) {
    return m[1] === "sfx"
      ? "sfx"
      : m[1] === "instruments"
        ? "instrument"
        : "song";
  }
  return path.startsWith("out/") ? "render" : null;
}

export const DIR_OF = {
  instrument: "instruments",
  sfx: "sfx",
  song: "songs",
} as const;
export const pathFor = (kind: "sfx" | "instrument" | "song", id: string) =>
  `${DIR_OF[kind]}/${id}.json`;
export const idOfPath = (path: string) =>
  (path.split("/").pop() ?? "").replace(/\.json$/, "");

/** 12 hex characters, like the server's etag (a hash of the bytes). */
export function etagOf(text: string): string {
  let h1 = 0x81_1c_9d_c5;
  let h2 = 0x01_00_01_93 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01_00_01_93) >>> 0;
    h2 = Math.imul(h2 + c, 0x85_eb_ca_6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
  ).slice(0, 12);
}

/** Documents are stored as pretty JSON with a trailing newline, like the CLI writes them. */
export const stringify = (json: unknown): string =>
  `${JSON.stringify(json, null, 2)}\n`;
