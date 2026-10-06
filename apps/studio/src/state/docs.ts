/* The project in memory: every document with its etag, undo history, dirty flag and conflict state, loaded through the
   ProjectStore. Views read `project.list(kind)` and edit through `project.edit(doc, fn)`; saving, autosave, undo and the
   "changed on disk" handling (section 6.3) all live here so no view has to know about them. */
import type {
  Instrument,
  Issue,
  Normalized,
  Project,
  Sfx,
  Song,
} from "../lib/contract.ts";
import {
  defaultProject,
  normalizeInstrument,
  normalizeProject,
  normalizeSfx,
  normalizeSong,
} from "../lib/core.ts";
import { fire, prefs } from "../lib/dom.ts";
import { createHistory, type History } from "../lib/history.ts";
import {
  ID_RE,
  idOfPath,
  kindOfPath,
  type ProjectStore,
  pathFor,
  type ServerMessage,
  type WriteResult,
} from "../store/store.ts";

export type DocKind = "sfx" | "instrument" | "song";
export type AnyDoc = Sfx | Instrument | Song;

export interface Doc<T = AnyDoc> {
  conflict: { etag: string; json: unknown } | null;
  dirty: boolean;
  etag: string | null;
  /** Time of the last change that came from outside (the sidebar flashes the row). */
  flashAt: number;
  history: History;
  id: string;
  issues: Issue[];
  kind: DocKind;
  path: string;
  /** Time of the last local edit, for hashing renders. */
  rev: number;
  savedText: string;
  /** The last write failed for a reason other than a conflict or invalid content (the file system, the network). */
  saveFailed: boolean;
  saving: boolean;
  value: T;
}

type ProjectEvent =
  | { type: "list" }
  | {
      type: "doc";
      path: string;
      cause: "edit" | "undo" | "external" | "saved" | "conflict" | "load";
    }
  | { type: "project" }
  /** A write started or ended, for the status icon only. */
  | { type: "saving" };

const SAVE_DELAY = 800;

const KIND_ALIASES: Partial<Record<string, DocKind[]>> = {
  instrument: ["instrument"],
  instruments: ["instrument"],
  sfx: ["sfx"],
  song: ["song"],
  songs: ["song"],
};

class ProjectState {
  store!: ProjectStore;
  project: Project = defaultProject();
  root = "";
  readonly docs = new Map<string, Doc>();
  projectDoc: {
    etag: string | null;
    savedText: string;
    history: History;
    conflict: { etag: string; json: unknown } | null;
  } = {
    conflict: null,
    etag: null,
    history: createHistory(),
    savedText: "",
  };
  autosave = prefs.get("autosave", true);
  private readonly listeners = new Set<(e: ProjectEvent) => void>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void) | null = null;
  /** File messages that arrived while a write to the path was in flight, one list per write. */
  private readonly inflight = new Map<
    string,
    Extract<ServerMessage, { type: "file" }>[][]
  >();
  /** Set when the studio server asks to play something. */
  onRemotePlay: ((ref: string, visual: boolean) => void) | null = null;
  onLog: ((level: string, message: string) => void) | null = null;

  subscribe(fn: (e: ProjectEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: ProjectEvent): void {
    for (const fn of this.listeners) {
      fn(e);
    }
  }

  async load(store: ProjectStore): Promise<void> {
    this.off?.();
    this.store = store;
    this.docs.clear();
    const info = await store.open();
    this.root = info.root;
    this.project = normalizeProject(info.project).value;
    const text = JSON.stringify(this.project);
    this.projectDoc = {
      conflict: null,
      etag: info.files.find((f) => f.path === "project.json")?.etag ?? null,
      history: createHistory(),
      savedText: text,
    };
    this.projectDoc.history.reset(text);
    const wanted = info.files.filter(
      (f) => f.kind === "sfx" || f.kind === "instrument" || f.kind === "song"
    );
    const loaded = await Promise.all(
      wanted.map(async (f) => {
        try {
          return { f, file: await store.readJson(f.path) };
        } catch {
          return null;
        }
      })
    );
    // instruments first: songs are normalized against them
    for (const kind of ["sfx", "instrument", "song"] as const) {
      for (const item of loaded) {
        if (item && item.f.kind === kind) {
          this.ingest(kind, item.f.path, item.file.json, item.file.etag);
        }
      }
    }
    this.off = store.subscribe((m) => this.onServerMessage(m));
    this.emit({ type: "list" });
    this.emit({ type: "project" });
  }

  /* ----- reading ----- */

  list(kind: DocKind): Doc[] {
    return [...this.docs.values()]
      .filter((d) => d.kind === kind)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  get<T = AnyDoc>(kind: DocKind, id: string): Doc<T> | undefined {
    return this.docs.get(pathFor(kind, id)) as Doc<T> | undefined;
  }

  instruments(): Record<string, Instrument> {
    const out: Record<string, Instrument> = {};
    for (const d of this.list("instrument")) {
      out[d.id] = d.value as Instrument;
    }
    return out;
  }

  /** Resolve "sfx/coin", "song/title", "instrument/lead" or a bare id (sfx first). */
  find(ref: string): Doc | undefined {
    const [a, b] = ref.includes("/") ? ref.split("/") : [null, ref];
    const kinds: DocKind[] = KIND_ALIASES[a ?? ""] ?? [
      "sfx",
      "song",
      "instrument",
    ];
    for (const k of kinds) {
      const d = this.get(k, b ?? "");
      if (d) {
        return d;
      }
    }
    return undefined;
  }

  get dirtyCount(): number {
    return (
      [...this.docs.values()].filter((d) => d.dirty).length +
      (this.projectDirty ? 1 : 0)
    );
  }

  /** How many documents are being written right now. */
  get savingCount(): number {
    return [...this.docs.values()].filter((d) => d.saving).length;
  }

  /** How many documents have a failed write or a conflict with the file on disk. */
  get failedCount(): number {
    return [...this.docs.values()].filter((d) => d.saveFailed || d.conflict)
      .length;
  }

  get projectDirty(): boolean {
    return JSON.stringify(this.project) !== this.projectDoc.savedText;
  }

  /* ----- normalizing ----- */

  normalize(kind: DocKind, json: unknown): Normalized<AnyDoc> {
    if (kind === "sfx") {
      return normalizeSfx(json);
    }
    if (kind === "instrument") {
      return normalizeInstrument(json);
    }
    return normalizeSong(json, this.instruments());
  }

  private ingest(
    kind: DocKind,
    path: string,
    json: unknown,
    etag: string | null
  ): Doc {
    const n = this.normalize(kind, json);
    const text = JSON.stringify(n.value);
    const prev = this.docs.get(path);
    const doc: Doc = {
      conflict: null,
      dirty: false,
      etag,
      flashAt: 0,
      history: prev?.history ?? createHistory(),
      id: idOfPath(path),
      issues: n.issues,
      kind,
      path,
      rev: Date.now(),
      savedText: text,
      saveFailed: false,
      saving: false,
      value: n.value,
    };
    doc.history.reset(text);
    this.docs.set(path, doc);
    return doc;
  }

  /* ----- editing ----- */

  /** Change a document. `fn` may mutate the draft it gets, or return an object to replace it. */
  edit<T extends AnyDoc>(
    doc: Doc,
    fn: (draft: T) => unknown,
    coalesce = ""
  ): void {
    const draft = JSON.parse(JSON.stringify(doc.value)) as T;
    const out = fn(draft);
    const next = (typeof out === "object" && out !== null ? out : draft) as T;
    const n = this.normalize(doc.kind, next);
    const text = JSON.stringify(n.value);
    if (text === JSON.stringify(doc.value)) {
      doc.issues = n.issues;
      return;
    }
    doc.value = n.value;
    doc.issues = n.issues;
    doc.history.push(text, coalesce);
    doc.dirty = text !== doc.savedText;
    doc.rev = Date.now();
    this.emit({ cause: "edit", path: doc.path, type: "doc" });
    this.scheduleSave(doc);
  }

  editProject(fn: (p: Project) => unknown, coalesce = ""): void {
    const draft = JSON.parse(JSON.stringify(this.project)) as Project;
    const out = fn(draft);
    const n = normalizeProject(
      typeof out === "object" && out !== null ? out : draft
    );
    const text = JSON.stringify(n.value);
    if (text === JSON.stringify(this.project)) {
      return;
    }
    this.project = n.value;
    this.projectDoc.history.push(text, `project:${coalesce}`);
    this.emit({ type: "project" });
    if (this.autosave) {
      this.scheduleProjectSave();
    }
  }

  undo(doc: Doc): boolean {
    const text = doc.history.undo();
    return text === null ? false : this.restore(doc, text, "undo");
  }

  redo(doc: Doc): boolean {
    const text = doc.history.redo();
    return text === null ? false : this.restore(doc, text, "undo");
  }

  private restore(doc: Doc, text: string, cause: "undo"): boolean {
    const n = this.normalize(doc.kind, JSON.parse(text));
    doc.value = n.value;
    doc.issues = n.issues;
    doc.dirty = text !== doc.savedText;
    doc.rev = Date.now();
    this.emit({ cause, path: doc.path, type: "doc" });
    this.scheduleSave(doc);
    return true;
  }

  /* ----- saving ----- */

  private scheduleSave(doc: Doc): void {
    clearTimeout(this.timers.get(doc.path));
    if (!(this.autosave && doc.dirty) || doc.conflict) {
      return;
    }
    this.timers.set(
      doc.path,
      setTimeout(() => fire(this.save(doc)), SAVE_DELAY)
    );
  }

  private scheduleProjectSave(): void {
    clearTimeout(this.timers.get("project.json"));
    this.timers.set(
      "project.json",
      setTimeout(() => fire(this.saveProject()), SAVE_DELAY)
    );
  }

  setAutosave(on: boolean): void {
    this.autosave = on;
    prefs.set("autosave", on);
    if (on) {
      for (const d of this.docs.values()) {
        this.scheduleSave(d);
      }
      if (this.projectDirty) {
        this.scheduleProjectSave();
      }
    }
    this.emit({ type: "project" });
  }

  /** Save a document. `overwrite` ignores the etag (Keep mine). `force` writes a clean document too, still with the
   etag. Returns false when it did not save. */
  async save(doc: Doc, overwrite = false, force = false): Promise<boolean> {
    clearTimeout(this.timers.get(doc.path));
    if (!(doc.dirty || overwrite || force)) {
      return true;
    }
    const n = this.normalize(doc.kind, doc.value);
    doc.issues = n.issues;
    if (!n.ok) {
      this.emit({ cause: "edit", path: doc.path, type: "doc" });
      return false;
    }
    const text = JSON.stringify(doc.value);
    doc.saving = true;
    doc.saveFailed = false;
    this.emit({ type: "saving" });
    const res = await this.write(
      doc.path,
      doc.value,
      overwrite ? undefined : (doc.etag ?? undefined)
    );
    doc.saving = false;
    if (res.ok) {
      doc.etag = res.etag;
      doc.savedText = text;
      doc.dirty = JSON.stringify(doc.value) !== text;
      doc.conflict = null;
      this.emit({ cause: "saved", path: doc.path, type: "doc" });
      if (doc.dirty) {
        this.scheduleSave(doc);
      }
      return true;
    }
    if (res.reason === "conflict") {
      doc.conflict = { etag: res.etag, json: res.json };
      this.emit({ cause: "conflict", path: doc.path, type: "doc" });
    } else if (res.reason === "invalid") {
      doc.issues = res.issues;
      this.emit({ cause: "edit", path: doc.path, type: "doc" });
    } else {
      doc.saveFailed = true;
      this.emit({ type: "saving" });
      this.onLog?.("error", res.message);
    }
    return false;
  }

  async saveProject(): Promise<boolean> {
    clearTimeout(this.timers.get("project.json"));
    const text = JSON.stringify(this.project);
    const res = await this.write(
      "project.json",
      this.project,
      this.projectDoc.etag ?? undefined
    );
    if (res.ok) {
      this.projectDoc.etag = res.etag;
      this.projectDoc.savedText = text;
      this.emit({ type: "project" });
      return true;
    }
    if (res.reason === "conflict") {
      this.projectDoc.conflict = { etag: res.etag, json: res.json };
      this.emit({ type: "project" });
    }
    return false;
  }

  async saveAll(): Promise<void> {
    await Promise.all(
      [...this.docs.values()].filter((d) => d.dirty).map((d) => this.save(d))
    );
    if (this.projectDirty) {
      await this.saveProject();
    }
  }

  /** Conflict bar: take what is on disk. */
  reload(doc: Doc): void {
    const c = doc.conflict;
    if (!c) {
      return;
    }
    const n = this.normalize(doc.kind, c.json);
    const text = JSON.stringify(n.value);
    doc.value = n.value;
    doc.issues = n.issues;
    doc.etag = c.etag;
    doc.savedText = text;
    doc.dirty = false;
    doc.conflict = null;
    doc.history.push(text);
    doc.rev = Date.now();
    this.emit({ cause: "external", path: doc.path, type: "doc" });
  }

  keepMine(doc: Doc): Promise<boolean> {
    doc.conflict = null;
    return this.save(doc, true);
  }

  /* ----- writing through the store ----- */

  /** Write through the store and swallow the echo of our own write. A store may announce the write to its subscribers
   before writeJson returns (the LocalStore does), when the etag is not known here yet, so file messages for the path
   are held while the write is in flight and the ones carrying the etag we got back are dropped. Anything else is a
   real outside change and is handled afterwards. */
  private async write(
    path: string,
    json: unknown,
    ifMatch?: string
  ): Promise<WriteResult> {
    const held: Extract<ServerMessage, { type: "file" }>[] = [];
    const outer = this.inflight.get(path);
    this.inflight.set(path, [...(outer ?? []), held]);
    let res: WriteResult;
    try {
      res = await this.store.writeJson(path, json, ifMatch);
    } finally {
      const rest = (this.inflight.get(path) ?? []).filter((h) => h !== held);
      if (rest.length > 0) {
        this.inflight.set(path, rest);
      } else {
        this.inflight.delete(path);
      }
    }
    for (const m of held) {
      if (!(res.ok && m.etag === res.etag)) {
        fire(this.onFile(m));
      }
    }
    return res;
  }

  /* ----- creating and deleting ----- */

  uniqueId(kind: DocKind, base: string): string {
    const slug =
      base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 56) || kind;
    let id = ID_RE.test(slug) ? slug : `${kind}-1`;
    for (let n = 2; this.get(kind, id); n += 1) {
      id = `${slug}-${n}`;
    }
    return id;
  }

  async create(kind: DocKind, id: string, value: AnyDoc): Promise<Doc> {
    const path = pathFor(kind, id);
    const n = this.normalize(kind, value);
    const res = await this.write(path, n.value);
    const doc = this.ingest(kind, path, n.value, res.ok ? res.etag : null);
    doc.dirty = !res.ok;
    this.emit({ type: "list" });
    return doc;
  }

  async remove(doc: Doc): Promise<void> {
    clearTimeout(this.timers.get(doc.path));
    await this.store.remove(doc.path);
    this.docs.delete(doc.path);
    this.emit({ type: "list" });
  }

  duplicate(doc: Doc): Promise<Doc> {
    const id = this.uniqueId(doc.kind, `${doc.id}-copy`);
    const copy = JSON.parse(JSON.stringify(doc.value)) as AnyDoc & {
      name: string;
    };
    copy.name = `${copy.name} copy`;
    return this.create(doc.kind, id, copy);
  }

  /* ----- the server pushing changes ----- */

  private onServerMessage(m: ServerMessage): void {
    if (m.type === "play") {
      this.onRemotePlay?.(m.ref, m.visual);
      return;
    }
    if (m.type === "log") {
      this.onLog?.(m.level, m.message);
      return;
    }
    if (m.type === "hello") {
      return;
    }
    if (m.type === "deleted") {
      if (this.docs.delete(m.path)) {
        this.emit({ type: "list" });
      }
      return;
    }
    if (m.type === "file") {
      const writes = this.inflight.get(m.path);
      if (writes && writes.length > 0) {
        for (const held of writes) {
          held.push(m);
        }
        return;
      }
      fire(this.onFile(m));
    }
  }

  private async onFile(
    m: Extract<ServerMessage, { type: "file" }>
  ): Promise<void> {
    const kind = kindOfPath(m.path);
    if (kind === "project") {
      if (this.projectDoc.etag === m.etag) {
        return;
      }
      const json = m.json ?? (await this.store.readJson(m.path)).json;
      if (this.projectDirty) {
        this.projectDoc.conflict = { etag: m.etag, json };
      } else {
        this.project = normalizeProject(json).value;
        this.projectDoc.etag = m.etag;
        this.projectDoc.savedText = JSON.stringify(this.project);
      }
      this.emit({ type: "project" });
      return;
    }
    if (kind !== "sfx" && kind !== "instrument" && kind !== "song") {
      return;
    }
    const doc = this.docs.get(m.path);
    if (doc?.etag === m.etag) {
      return;
    }
    let { json } = m;
    if (json === undefined) {
      try {
        ({ json } = await this.store.readJson(m.path));
      } catch {
        return;
      }
    }
    if (!doc) {
      this.ingest(kind, m.path, json, m.etag);
      this.emit({ type: "list" });
      return;
    }
    if (doc.dirty) {
      doc.conflict = { etag: m.etag, json };
      this.emit({ cause: "conflict", path: doc.path, type: "doc" });
      return;
    }
    const n = this.normalize(kind, json);
    const text = JSON.stringify(n.value);
    doc.value = n.value;
    doc.issues = n.issues;
    doc.etag = m.etag;
    doc.savedText = text;
    doc.dirty = false;
    doc.history.push(text);
    doc.flashAt = Date.now();
    doc.rev = Date.now();
    this.emit({ cause: "external", path: doc.path, type: "doc" });
  }
}

export const project = new ProjectState();
