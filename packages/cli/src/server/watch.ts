// Recursive fs.watch over the project folder with a 50 ms debounce per path (architecture.md 6.3).
import fs from "node:fs";
import path from "node:path";
import type { ApiState } from "./api.ts";
import { fileMessage } from "./api.ts";
import { classify } from "./paths.ts";

const DEBOUNCE_MS = 50;

export interface Watcher {
  close: () => void;
}

/** Looks at one path after its debounce and broadcasts `file` or `deleted` unless clients already know that state. */
function settle(state: ApiState, rel: string): void {
  const abs = path.join(state.root, rel);
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat) {
    if (state.known.get(rel) === null) {
      return;
    }
    state.known.set(rel, null);
    state.hub.broadcast({ path: rel, type: "deleted" });
    return;
  }
  if (!stat.isFile()) {
    return;
  }
  const msg = fileMessage(state.root, rel);
  if (!msg) {
    return;
  }
  if (state.known.get(rel) === msg.etag) {
    return;
  }
  state.known.set(rel, msg.etag);
  state.hub.broadcast(msg);
}

const WATCHED_TOP = new Set(["sfx", "instruments", "songs", "out"]);

/**
 * Watches project.json, the three document folders and out/** with one non-recursive fs.watch per directory.
 * (A recursive fs.watch on Linux is a JS emulation that loses track of a file once an atomic save replaces its
 * inode, which is exactly how this server and many editors write files; directory watchers see every replace.)
 */
export function startWatcher(
  state: ApiState,
  onError: (message: string) => void
): Watcher {
  const timers = new Map<string, NodeJS.Timeout>();
  const watchers = new Map<string, fs.FSWatcher>();
  let closed = false;

  const schedule = (rel: string) => {
    const pending = timers.get(rel);
    if (pending) {
      clearTimeout(pending);
    }
    timers.set(
      rel,
      setTimeout(() => {
        timers.delete(rel);
        try {
          settle(state, rel);
        } catch (error) {
          onError(`watcher: ${(error as Error).message}`);
        }
      }, DEBOUNCE_MS)
    );
  };

  const wanted = (rel: string): boolean => {
    const parts = rel.split("/");
    const top = parts[0] ?? "";
    return (
      rel === "" ||
      (WATCHED_TOP.has(top) && (top === "out" || parts.length === 1))
    );
  };

  const watchDir = (rel: string) => {
    if (closed || watchers.has(rel)) {
      return;
    }
    const abs = rel ? path.join(state.root, rel) : state.root;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(abs, (_event, name) => {
        if (!name) {
          scan(rel);
          return;
        }
        const child = rel ? `${rel}/${name.toString()}` : name.toString();
        handle(child);
      });
    } catch {
      return;
    }
    w.on("error", () => {
      w.close();
      watchers.delete(rel);
    });
    watchers.set(rel, w);
    scan(rel);
  };

  const handle = (child: string) => {
    if (child.split("/").some((p) => p.startsWith("."))) {
      return;
    }
    let isDir = false;
    try {
      isDir = fs.statSync(path.join(state.root, child)).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir) {
      if (wanted(child)) {
        watchDir(child);
      }
      return;
    }
    if (classify(child)) {
      schedule(child);
    }
  };

  /** Remembers the etag of a file that was already on disk when the watcher started, so only real changes are announced. */
  const remember = (child: string) => {
    const msg = fileMessage(state.root, child);
    if (msg) {
      state.known.set(child, msg.etag);
    }
  };

  const scanEntry = (rel: string, e: fs.Dirent) => {
    const child = rel ? `${rel}/${e.name}` : e.name;
    if (e.name.startsWith(".")) {
      return;
    }
    if (e.isDirectory()) {
      if (wanted(child)) {
        watchDir(child);
      }
    } else if (
      e.isFile() &&
      rel !== "" &&
      classify(child) &&
      !state.known.has(child)
    ) {
      remember(child);
    }
  };

  /** Starts watching sub folders that exist and reports files that appeared before the watch began. */
  const scan = (rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(state.root, rel) : state.root, {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const e of entries) {
      scanEntry(rel, e);
    }
  };

  try {
    watchDir("");
  } catch (error) {
    onError(`file watching is unavailable: ${(error as Error).message}`);
  }
  return {
    close: () => {
      closed = true;
      for (const w of watchers.values()) {
        w.close();
      }
      watchers.clear();
      for (const t of timers.values()) {
        clearTimeout(t);
      }
      timers.clear();
    },
  };
}
