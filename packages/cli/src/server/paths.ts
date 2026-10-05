// Which project paths the studio server may touch (architecture.md 6.3): project.json, sfx/*.json,
// instruments/*.json, songs/*.json and anything under out/. Everything else is 403.
import fs from "node:fs";
import path from "node:path";
import { type DocKind, ID_PATTERN } from "../project.ts";

export type FileKind = "instrument" | "project" | "render" | "sfx" | "song";

export interface Classified {
  docKind: DocKind | null;
  id: string | null;
  kind: FileKind;
}

const DOC_DIRS: Record<string, DocKind> = {
  instruments: "instrument",
  sfx: "sfx",
  songs: "song",
};

/** A clean project relative posix path, or null when the input could escape or hide (absolute, .., dotfiles). */
export function cleanRelPath(input: string | null | undefined): string | null {
  if (
    !input ||
    input.includes("\0") ||
    input.includes("\\") ||
    input.startsWith("/")
  ) {
    return null;
  }
  const parts = input.split("/");
  if (
    parts.some((p) => p === "" || p === "." || p === ".." || p.startsWith("."))
  ) {
    return null;
  }
  return parts.join("/");
}

export function classify(rel: string): Classified | null {
  if (rel === "project.json") {
    return { docKind: null, id: null, kind: "project" };
  }
  const parts = rel.split("/");
  const dir = parts[0] ?? "";
  if (parts.length === 2 && DOC_DIRS[dir]) {
    const file = parts[1] ?? "";
    if (file.endsWith(".json") && ID_PATTERN.test(file.slice(0, -5))) {
      const docKind = DOC_DIRS[dir] as DocKind;
      return { docKind, id: file.slice(0, -5), kind: docKind };
    }
    return null;
  }
  if (dir === "out" && parts.length >= 2) {
    return { docKind: null, id: null, kind: "render" };
  }
  return null;
}

/** True when the real path of `abs` stays inside the real project root (symlinks cannot escape out/). */
export function insideRoot(root: string, abs: string): boolean {
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + path.sep);
  } catch {
    return false;
  }
}

const TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".wav": "audio/wav",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export function contentType(file: string): string {
  return TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
