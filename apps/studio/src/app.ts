/* App-wide state the views share: the current route, the toast, the open view's hooks and navigation. It imports no
   views (shell.ts wires those in), so views can import it freely. */
import type { Doc } from "./state/docs.ts";
import { project } from "./state/docs.ts";

const HASH_PREFIX = /^#\/?/;

export type Route =
  | { view: "pads" }
  | { view: "sfx"; id: string }
  | { view: "song"; id: string }
  | { view: "instrument"; id: string }
  | { view: "analysis"; ref: string }
  | { view: "project"; export?: boolean };

export function parseRoute(hash: string): Route {
  const [path = "", query = ""] = hash.split("?");
  const parts = path
    .replace(HASH_PREFIX, "")
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  const [v, a, b] = parts;
  if (v === "sfx" && a) {
    return { id: a, view: "sfx" };
  }
  if (v === "song" && a) {
    return { id: a, view: "song" };
  }
  if (v === "instrument" && a) {
    return { id: a, view: "instrument" };
  }
  if (v === "analysis") {
    // no ref: the view lists the sounds to pick from
    const ref = [a, b].filter(Boolean).join("/");
    return { ref, view: "analysis" };
  }
  if (v === "project") {
    return new URLSearchParams(query).get("export")
      ? { export: true, view: "project" }
      : { view: "project" };
  }
  return { view: "pads" };
}

export function routeHash(r: Route): string {
  switch (r.view) {
    case "sfx":
    case "song":
    case "instrument":
      return `#/${r.view}/${encodeURIComponent(r.id)}`;
    case "analysis":
      return r.ref ? `#/analysis/${r.ref}` : "#/analysis";
    case "project":
      return "#/project";
    default:
      return "#/pads";
  }
}

/** Where "open the analysis" goes: the sound or song being edited, else the list to pick one from. */
export function analysisHash(doc: Doc | null): string {
  return doc && doc.kind !== "instrument"
    ? `#/analysis/${doc.kind}/${doc.id}`
    : "#/analysis";
}

export interface Command {
  enabled?: () => boolean;
  group: string;
  icon?: string;
  id: string;
  keys?: string;
  run: () => void;
  title: string;
}

/** What the open view offers the shell: transport actions, key handling, its own palette commands. */
export interface ViewHooks {
  /** The chip whose look the badge and backdrop follow. */
  chip?: () => import("./lib/contract.ts").ChipId | null;
  commands?: () => Command[];
  /** The document the view edits, for undo, save, analysis and the conflict bar. */
  doc?: () => Doc | null;
  /** Return true when the key was handled. */
  onKey?: (e: KeyboardEvent) => boolean;
  /** Space */
  play?: () => void;
  stop?: () => void;
}

class App {
  route: Route = { view: "pads" };
  hooks: ViewHooks = {};
  private toastEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  /** set by the shell */
  openPalette: () => void = () => undefined;
  openHelp: () => void = () => undefined;
  openMenu: (on: boolean) => void = () => undefined;

  navigate(hash: string): void {
    if (location.hash === hash) {
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
      location.hash = hash;
    }
  }

  currentDoc(): Doc | null {
    return this.hooks.doc?.() ?? null;
  }

  bindToast(el: HTMLElement): void {
    this.toastEl = el;
  }

  toast(text: string, action?: string, run?: () => void): void {
    const el = this.toastEl;
    if (!el) {
      return;
    }
    el.replaceChildren();
    const span = document.createElement("span");
    span.textContent = text;
    el.append(span);
    if (action && run) {
      const b = document.createElement("button");
      b.className = "btn small";
      b.textContent = action;
      b.onclick = () => {
        el.hidden = true;
        run();
      };
      el.append(b);
    }
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 5000);
  }

  undo(): void {
    const d = this.currentDoc();
    if (d && !project.undo(d)) {
      this.toast("Nothing to undo");
    }
  }

  redo(): void {
    const d = this.currentDoc();
    if (d && !project.redo(d)) {
      this.toast("Nothing to redo");
    }
  }

  async save(): Promise<void> {
    const d = this.currentDoc();
    if (d) {
      // the etag check stays on: a newer file on disk raises the conflict bar instead of being overwritten
      const ok = await project.save(d, false, true);
      if (ok) {
        this.toast(`Saved ${d.id}`);
      } else if (d.conflict) {
        this.toast(`${d.id} changed on disk: choose Reload or Keep mine`);
      } else {
        this.toast("Could not save: fix the errors in the inspector");
      }
    } else {
      await project.saveAll();
      this.toast("Saved");
    }
  }
}

export const app = new App();
