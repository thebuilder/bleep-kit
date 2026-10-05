/* Undo and redo for one document: snapshots of its JSON text (documents are small), 200 steps, like Pixelkit's
   history. Quick successive edits of one control (a slider drag) share a coalesce key and make a single step. */

export interface History {
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  readonly current: string | undefined;
  push: (state: string, coalesce?: string, now?: number) => boolean;
  redo: () => string | null;
  reset: (state: string) => void;
  undo: () => string | null;
}

const COALESCE_MS = 700;

export function createHistory(limit = 200): History {
  let past: string[] = [];
  let future: string[] = [];
  let current: string | undefined;
  let lastKey = "";
  let lastAt = 0;
  return {
    get canRedo() {
      return future.length > 0;
    },
    get canUndo() {
      return past.length > 0;
    },
    get current() {
      return current;
    },
    push(state, coalesce = "", now = Date.now()) {
      if (current === state) {
        return false;
      }
      const merge =
        coalesce !== "" &&
        coalesce === lastKey &&
        now - lastAt < COALESCE_MS &&
        past.length > 0;
      if (current !== undefined && !merge) {
        past.push(current);
        if (past.length > limit) {
          past.shift();
        }
      }
      future = [];
      current = state;
      lastKey = coalesce;
      lastAt = now;
      return true;
    },
    redo() {
      const next = future.pop();
      if (next === undefined || current === undefined) {
        return null;
      }
      past.push(current);
      current = next;
      lastKey = "";
      return next;
    },
    reset(state) {
      past = [];
      future = [];
      current = state;
      lastKey = "";
    },
    undo() {
      const prev = past.pop();
      if (prev === undefined || current === undefined) {
        return null;
      }
      future.push(current);
      current = prev;
      lastKey = "";
      return prev;
    },
  };
}
