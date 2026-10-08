/* Standalone mode: the project lives in IndexedDB (database "bleepkit-studio", object store "files" keyed by path),
   with the same shapes the server returns. Without IndexedDB (a private window, tests) it falls back to memory. */

import type { ChipId } from "../lib/contract.ts";
import { defaultProject, normalizeProject } from "../lib/core.ts";
import { readZip, writeZip } from "../zip.ts";
import { starterFiles } from "./seed.ts";
import {
  etagOf,
  type FileEntry,
  type FileJson,
  kindOfPath,
  type ProjectInfo,
  type ProjectStore,
  type ServerMessage,
  stringify,
  type WriteResult,
} from "./store.ts";

const JSON_EXT = /\.json$/;
const ZIP_ROOT_FOLDER =
  /^[^/]+\/(?=(project\.json|sfx\/|songs\/|instruments\/))/;

interface Row {
  bytes?: Uint8Array;
  mtime: number;
  path: string;
  text?: string;
}

/** The key-value layer under the store: IndexedDB in the browser, a Map for tests. */
export interface FileBackend {
  all: () => Promise<Row[]>;
  clear: () => Promise<void>;
  del: (path: string) => Promise<void>;
  get: (path: string) => Promise<Row | undefined>;
  put: (row: Row) => Promise<void>;
}

export function memoryBackend(): FileBackend {
  const m = new Map<string, Row>();
  return {
    all: () => Promise.resolve([...m.values()]),
    clear: () => {
      m.clear();
      return Promise.resolve();
    },
    del: (p) => {
      m.delete(p);
      return Promise.resolve();
    },
    get: (p) => Promise.resolve(m.get(p)),
    put: (r) => {
      m.set(r.path, r);
      return Promise.resolve();
    },
  };
}

const DB_NAME = "bleepkit-studio";
const STORE = "files";

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbBackend(): Promise<FileBackend | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }
  try {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () =>
        open.result.createObjectStore(STORE, { keyPath: "path" });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      open.onblocked = () => reject(new Error("blocked"));
    });
    const store = (mode: IDBTransactionMode) =>
      db.transaction(STORE, mode).objectStore(STORE);
    return {
      all: () => req(store("readonly").getAll() as IDBRequest<Row[]>),
      clear: async () => {
        await req(store("readwrite").clear());
      },
      del: async (p) => {
        await req(store("readwrite").delete(p));
      },
      get: (p) => req(store("readonly").get(p) as IDBRequest<Row | undefined>),
      put: async (r) => {
        await req(store("readwrite").put(r));
      },
    };
  } catch {
    return null;
  }
}

/** Where a dropped document belongs, told by which keys it has. */
function folderOfShape(
  json: unknown
): "sfx" | "instruments" | "songs" | "project" | null {
  if (!json || typeof json !== "object") {
    return null;
  }
  if ("envelope" in json && "frequency" in json) {
    return "sfx";
  }
  if ("macros" in json && "kind" in json) {
    return "instruments";
  }
  if ("patterns" in json || "order" in json) {
    return "songs";
  }
  return "export" in json && "chip" in json ? "project" : null;
}

/** A file name as a document id: lower case, runs of other characters become one hyphen. */
const idFromFileName = (name: string): string =>
  name
    .replace(JSON_EXT, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "imported";

export class LocalStore implements ProjectStore {
  readonly mode = "local" as const;
  readonly label = "this browser";
  private readonly listeners = new Set<(m: ServerMessage) => void>();
  private readonly backend: FileBackend;
  /** True when the last `open` found no project and filled it with the starter kit. */
  seeded = false;

  constructor(backend: FileBackend) {
    this.backend = backend;
  }

  static async create(): Promise<LocalStore> {
    return new LocalStore((await idbBackend()) ?? memoryBackend());
  }

  private entry(r: Row): FileEntry {
    const text = r.text ?? "";
    return {
      etag: r.bytes ? etagOf(`${r.bytes.length}:${r.mtime}`) : etagOf(text),
      kind: kindOfPath(r.path) ?? "render",
      mtime: r.mtime,
      path: r.path,
      size: r.bytes ? r.bytes.length : text.length,
    };
  }

  /** Add the starter documents to a project that has none of its own. */
  async seed(overwrite = false): Promise<number> {
    const written = await Promise.all(
      [...starterFiles()].map(async ([path, json]) => {
        if (!overwrite && (await this.backend.get(path))) {
          return 0;
        }
        await this.backend.put({
          mtime: Date.now(),
          path,
          text: stringify(json),
        });
        return 1;
      })
    );
    return written.reduce<number>((a, b) => a + b, 0);
  }

  async open(): Promise<ProjectInfo> {
    this.seeded = false;
    if (!(await this.backend.get("project.json"))) {
      await this.seed(true);
      this.seeded = true;
    }
    const files = await this.list();
    const row = await this.backend.get("project.json");
    const project = normalizeProject(
      row?.text ? JSON.parse(row.text) : defaultProject()
    ).value;
    return { files, project, root: "Browser project" };
  }

  async list(): Promise<FileEntry[]> {
    return (await this.backend.all())
      .filter((r) => kindOfPath(r.path))
      .map((r) => this.entry(r));
  }

  async readJson(path: string): Promise<FileJson> {
    const r = await this.backend.get(path);
    if (!r || r.text === undefined) {
      throw new Error(`No such file: ${path}`);
    }
    const e = this.entry(r);
    return { etag: e.etag, json: JSON.parse(r.text), mtime: r.mtime, path };
  }

  async writeJson(
    path: string,
    json: unknown,
    ifMatch?: string
  ): Promise<WriteResult> {
    const prev = await this.backend.get(path);
    if (ifMatch && prev && this.entry(prev).etag !== ifMatch) {
      return {
        etag: this.entry(prev).etag,
        json: JSON.parse(prev.text ?? "null"),
        ok: false,
        reason: "conflict",
      };
    }
    const row: Row = { mtime: Date.now(), path, text: stringify(json) };
    await this.backend.put(row);
    const e = this.entry(row);
    // like the server: a write also comes back as a file message; the studio ignores the one it just made
    for (const fn of this.listeners) {
      fn({ etag: e.etag, mtime: e.mtime, path, type: "file" });
    }
    return { etag: e.etag, mtime: e.mtime, ok: true };
  }

  async remove(path: string): Promise<void> {
    await this.backend.del(path);
    for (const fn of this.listeners) {
      fn({ path, type: "deleted" });
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const r = await this.backend.get(path);
    return (
      r?.bytes ??
      (r?.text === undefined ? null : new TextEncoder().encode(r.text))
    );
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await this.backend.put({ bytes, mtime: Date.now(), path });
  }

  subscribe(fn: (m: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    this.listeners.clear();
  }

  /** The whole project as a stored zip (documents and renders). */
  async exportZip(): Promise<Uint8Array> {
    const entries = (await this.backend.all())
      .filter((r) => kindOfPath(r.path))
      .map((r) => ({
        data: r.bytes ?? new TextEncoder().encode(r.text ?? ""),
        path: r.path,
      }));
    return writeZip(entries);
  }

  /** Replace or add documents from a zip. Returns how many files were imported. */
  async importZip(bytes: Uint8Array, replace: boolean): Promise<number> {
    const entries = await readZip(bytes);
    // zips made from a folder may carry one top-level directory
    const stripped = entries.map((e) => ({
      ...e,
      path: e.path.replace(ZIP_ROOT_FOLDER, ""),
    }));
    const wanted = stripped.filter((e) => kindOfPath(e.path));
    if (replace) {
      await this.backend.clear();
    }
    await Promise.all(
      wanted.map((e) =>
        this.backend.put(
          e.path.endsWith(".json")
            ? {
                mtime: Date.now(),
                path: e.path,
                text: new TextDecoder().decode(e.data),
              }
            : { bytes: e.data, mtime: Date.now(), path: e.path }
        )
      )
    );
    return wanted.length;
  }

  /** A single JSON document dropped in: put it where its shape says (sfx, instrument, song or project). */
  async importDocument(name: string, text: string): Promise<string | null> {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const dir = folderOfShape(json);
    if (!dir) {
      return null;
    }
    const path =
      dir === "project"
        ? "project.json"
        : `${dir}/${idFromFileName(name)}.json`;
    await this.backend.put({ mtime: Date.now(), path, text: stringify(json) });
    return path;
  }

  /** One file of a dropped or picked folder, by its path inside it ("my-game/sfx/coin.json" or "sfx/coin.json"): a
   *  document keeps its place, anything else goes by the shape of its content. Returns false for what is not ours. */
  async importEntry(relPath: string, text: string): Promise<boolean> {
    const path = relPath.replace(ZIP_ROOT_FOLDER, "");
    if (
      path.endsWith(".json") &&
      kindOfPath(path) &&
      !path.startsWith("out/")
    ) {
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return false;
      }
      await this.backend.put({
        mtime: Date.now(),
        path,
        text: stringify(json),
      });
      return true;
    }
    return (
      (await this.importDocument(relPath.split("/").pop() ?? "", text)) !== null
    );
  }

  async resetToStarter(): Promise<void> {
    await this.backend.clear();
    await this.seed(true);
  }

  /** Replace everything with a clean project: no sounds, songs or instruments, only project.json with a name and a
   *  chip. */
  async resetToEmpty(name: string, chip: ChipId): Promise<void> {
    await this.backend.clear();
    const base = defaultProject(name.trim() || "Untitled");
    const json = normalizeProject({ ...base, chip }).value;
    await this.backend.put({
      mtime: Date.now(),
      path: "project.json",
      text: stringify(json),
    });
  }
}
