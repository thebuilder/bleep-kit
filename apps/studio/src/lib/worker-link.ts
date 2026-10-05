/* The page's end of a worker that answers requests by id: it starts the worker on first use, matches each answer to
   its request, and turns a worker that fails into rejected requests. Where there are no workers (tests) or the worker
   died, `request` returns null and the caller does the work itself on the main thread. */

export interface WorkerLink<Out> {
  /** Post a request; `send` gets the worker and the id to tag the message with. */
  request: (send: (worker: Worker, id: number) => void) => Promise<Out> | null;
}

interface Waiting<Out> {
  reject: (e: Error) => void;
  resolve: (out: Out) => void;
}

/**
 * `spawn` has to be `() => new Worker(new URL("./x.ts", import.meta.url), { type: "module" })` written out at the call
 * site, which is the form Vite recognises. `answer` turns a response without an `error` into the request's result.
 */
export function workerLink<Res extends { id: number }, Out>(
  spawn: () => Worker,
  label: string,
  answer: (res: Res) => Out
): WorkerLink<Out> {
  let worker: Worker | null | undefined;
  let nextId = 1;
  const pending = new Map<number, Waiting<Out>>();

  const onMessage = (e: MessageEvent<Res>): void => {
    const waiting = pending.get(e.data.id);
    if (!waiting) {
      return;
    }
    pending.delete(e.data.id);
    const { error } = e.data as { error?: string };
    if (error === undefined) {
      waiting.resolve(answer(e.data));
    } else {
      waiting.reject(new Error(error));
    }
  };

  const onFail = (): void => {
    worker = null;
    for (const waiting of pending.values()) {
      waiting.reject(new Error(`${label} worker failed`));
    }
    pending.clear();
  };

  const start = (): Worker | null => {
    if (worker !== undefined) {
      return worker;
    }
    try {
      worker = typeof Worker === "undefined" ? null : spawn();
      if (worker) {
        worker.onmessage = onMessage;
        worker.onerror = onFail;
      }
    } catch {
      worker = null;
    }
    return worker;
  };

  return {
    request(send) {
      const w = start();
      if (!w) {
        return null;
      }
      nextId += 1;
      const id = nextId;
      return new Promise<Out>((resolve, reject) => {
        pending.set(id, { reject, resolve });
        send(w, id);
      });
    },
  };
}
