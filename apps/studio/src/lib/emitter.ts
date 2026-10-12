/* A set of listeners to call when something changed: `subscribe` returns the way to stop listening. */
export function createEmitter(): {
  emit: () => void;
  subscribe: (fn: () => void) => () => void;
} {
  const listeners = new Set<() => void>();
  return {
    emit() {
      for (const fn of [...listeners]) {
        fn();
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
