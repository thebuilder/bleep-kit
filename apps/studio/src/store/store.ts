/* The ProjectStore: how the studio reads and writes a project. `server.ts` talks to the CLI's studio server
   (section 6.3), `local.ts` keeps the same shapes in IndexedDB (section 6.5). Paths are always relative to the
   project folder, with forward slashes. */
import type { Issue, Project } from "../lib/contract.ts";
import { hashString } from "../lib/core.ts";
import { choose } from "../lib/dom.ts";

const DOC_PATH = /^(sfx|instruments|songs)\/[^/]+\.json$/;
const JSON_EXT = /\.json$/;

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
  close: () => void;
  /** Server only: the studio server renders and writes the whole export. */
  exportAll?: (dryRun: boolean) => Promise<unknown>;
  /** Short text for the status area: the folder on disk, or "this browser". */
  readonly label: string;
  list: () => Promise<FileEntry[]>;
  readonly mode: "server" | "local";
  open: () => Promise<ProjectInfo>;
  readBytes: (path: string) => Promise<Uint8Array | null>;
  readJson: (path: string) => Promise<FileJson>;
  remove: (path: string) => Promise<void>;
  subscribe: (fn: (msg: ServerMessage) => void) => () => void;
  writeBytes: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Write a document; `ifMatch` is the etag the caller loaded, left out to overwrite. */
  writeJson: (
    path: string,
    json: unknown,
    ifMatch?: string
  ) => Promise<WriteResult>;
}

/** Document ids are file names without the extension. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function kindOfPath(path: string): FileKind | null {
  if (path === "project.json") {
    return "project";
  }
  const m = DOC_PATH.exec(path);
  if (m) {
    return choose(
      [
        [m[1] === "sfx", "sfx" as const],
        [m[1] === "instruments", "instrument" as const],
      ],
      "song" as const
    );
  }
  return path.startsWith("out/") ? "render" : null;
}

const DIR_OF = {
  instrument: "instruments",
  sfx: "sfx",
  song: "songs",
} as const;
export const pathFor = (kind: "sfx" | "instrument" | "song", id: string) =>
  `${DIR_OF[kind]}/${id}.json`;
export const idOfPath = (path: string) =>
  (path.split("/").pop() ?? "").replace(JSON_EXT, "");

/** 12 hex characters, like the server's etag (a hash of the bytes). */
export function etagOf(text: string): string {
  const h1 = hashString(text);
  const h2 = hashString(`${text.length}:${text}`);
  return (
    h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0")
  ).slice(0, 12);
}

/** Documents are stored as pretty JSON with a trailing newline, like the CLI writes them. */
export const stringify = (json: unknown): string =>
  `${JSON.stringify(json, null, 2)}\n`;
