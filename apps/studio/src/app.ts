/* App-wide state the views share: the current route, the toast, the open view's hooks and navigation. It imports no
   views (shell.ts wires those in), so views can import it freely. */
import type { Doc } from "./state/docs.ts";
import { project } from "./state/docs.ts";

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
    .replace(/^#\/?/, "")
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
  if (v === "analysis" && a) {
    return { ref: b ? `${a}/${b}` : a, view: "analysis" };
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
      return `#/analysis/${r.ref}`;
    case "project":
      return "#/project";
    default:
      return "#/pads";
  }
}

export interface Command {
  enabled?(): boolean;
  group: string;
  icon?: string;
  id: string;
  keys?: string;
  run(): void;
  title: string;
}

/** What the open view offers the shell: transport actions, key handling, its own palette commands. */
export interface ViewHooks {
  /** The chip whose look the badge and backdrop follow. */
  chip?(): import("./lib/contract.ts").ChipId | null;
  commands?(): Command[];
  /** The document the view edits, for undo, save, analysis and the conflict bar. */
  doc?(): Doc | null;
  /** Return true when the key was handled. */
  onKey?(e: KeyboardEvent): boolean;
  /** Space */
  play?(): void;
  stop?(): void;
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
      const ok = await project.save(d, true);
      this.toast(
        ok ? `Saved ${d.id}` : "Could not save: fix the errors in the inspector"
      );
    } else {
      await project.saveAll();
      this.toast("Saved");
    }
  }
}

export const app = new App();
