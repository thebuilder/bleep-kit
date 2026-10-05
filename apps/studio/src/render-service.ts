/* Asks the render worker for audio and caches the answers. Without Workers (tests) it renders on the main thread in a
   later task, so callers always get a promise. Peaks and thumbnails are derived here. */
import type { Instrument, RenderResult, Sfx, Song } from "./lib/contract.ts";
import type {
  AnalysisBundle,
  RenderRequest,
  RenderResponse,
  Source,
} from "./workers/render.ts";
import { runRequest } from "./workers/render.ts";

let worker: Worker | null | undefined;
let nextId = 1;
type Out = RenderResult | AnalysisBundle;
const pending = new Map<
  number,
  { resolve: (r: Out) => void; reject: (e: Error) => void }
>();
const cache = new Map<string, Out>();
const inflight = new Map<string, Promise<Out>>();
const CACHE_MAX = 120;

function getWorker(): Worker | null {
  if (worker !== undefined) {
    return worker;
  }
  try {
    if (typeof Worker === "undefined") {
      worker = null;
    } else {
      worker = new Worker(new URL("./workers/render.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e: MessageEvent<RenderResponse>) => {
        const p = pending.get(e.data.id);
        if (!p) {
          return;
        }
        pending.delete(e.data.id);
        if ("error" in e.data) {
          p.reject(new Error(e.data.error));
        } else if ("bundle" in e.data) {
          p.resolve(e.data.bundle);
        } else {
          p.resolve(e.data.result);
        }
      };
      worker.onerror = () => {
        worker = null;
        for (const [, p] of pending) {
          p.reject(new Error("render worker failed"));
        }
        pending.clear();
      };
    }
  } catch {
    worker = null;
  }
  return worker;
}

type Req = RenderRequest extends infer R
  ? R extends unknown
    ? Omit<R, "id">
    : never
  : never;

function run(req: Req, key: string): Promise<Out> {
  const hit = cache.get(key);
  if (hit) {
    return Promise.resolve(hit);
  }
  const open = inflight.get(key);
  if (open) {
    return open;
  }
  const id = nextId++;
  const w = getWorker();
  const p = new Promise<Out>((resolve, reject) => {
    if (w) {
      pending.set(id, { reject, resolve });
      w.postMessage({ ...req, id });
    } else {
      setTimeout(() => {
        try {
          resolve(runRequest({ ...req, id } as RenderRequest));
        } catch (err) {
          reject(err as Error);
        }
      }, 0);
    }
  }).then((r) => {
    cache.set(key, r);
    if (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value as string);
    }
    inflight.delete(key);
    return r;
  });
  p.catch(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export const renderSfxAsync = (
  sfx: Sfx,
  rate = 44_100
): Promise<RenderResult> =>
  run(
    { kind: "sfx", rate, sfx },
    `sfx:${rate}:${JSON.stringify(sfx)}`
  ) as Promise<RenderResult>;

export const renderSongAsync = (
  song: Song,
  instruments: Record<string, Instrument>,
  rate = 44_100,
  stems = false
): Promise<RenderResult> =>
  run(
    { instruments, kind: "song", rate, song, stems },
    `song:${rate}:${stems}:${JSON.stringify([song, instruments])}`
  ) as Promise<RenderResult>;

export const renderNoteAsync = (
  inst: Instrument,
  note: number,
  rate = 44_100
): Promise<RenderResult> =>
  run(
    { inst, kind: "note", note, rate },
    `note:${rate}:${note}:${JSON.stringify(inst)}`
  ) as Promise<RenderResult>;

/** Render, analyse and draw the analysis images, all in the worker. */
export function analyzeAsync(
  source: Source,
  file: string,
  width = 1100,
  rate = 44_100
): Promise<AnalysisBundle> {
  const key = `ana:${rate}:${width}:${file}:${JSON.stringify(source)}`;
  // the images are big, so they are not kept in the cache
  return (
    run(
      { file, kind: "analysis", rate, source, width },
      key
    ) as Promise<AnalysisBundle>
  ).then((b) => {
    cache.delete(key);
    return b;
  });
}

/** min and max per bucket, interleaved, from the left channel. */
export function peaks(r: RenderResult, buckets: number): Float32Array {
  const out = new Float32Array(buckets * 2);
  const ch = r.channels[0];
  if (!ch || r.frames === 0) {
    return out;
  }
  const per = r.frames / buckets;
  for (let b = 0; b < buckets; b++) {
    let lo = 0;
    let hi = 0;
    const from = Math.floor(b * per);
    const to = Math.max(from + 1, Math.floor((b + 1) * per));
    for (let i = from; i < to && i < r.frames; i++) {
      const v = ch[i] ?? 0;
      if (v < lo) {
        lo = v;
      }
      if (v > hi) {
        hi = v;
      }
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}
