/* Asks the render worker for audio and caches the answers. Without Workers (tests) it renders on the main thread in a
   later task, so callers always get a promise. It also remembers how long each sound really lasted when it was last
   rendered, which is what the pads and the editor show: the envelope times only say how long the sound is asked to
   run, and a chip can gate it off sooner (the NES triangle) or let the tail ring on. */
import type { Instrument, RenderResult, Sfx, Song } from "./lib/contract.ts";
import { workerLink } from "./lib/worker-link.ts";
import { project } from "./state/docs.ts";
import type {
  AnalysisBundle,
  RenderMaster,
  RenderRequest,
  RenderResponse,
  Source,
} from "./workers/render.ts";
import { runRequest } from "./workers/render.ts";

type Out = RenderResult | AnalysisBundle;
const cache = new Map<string, Out>();
const inflight = new Map<string, Promise<Out>>();
const CACHE_MAX = 120;

const link = workerLink<RenderResponse, Out>(
  () =>
    new Worker(new URL("./workers/render.ts", import.meta.url), {
      type: "module",
    }),
  "render",
  (res) =>
    "bundle" in res
      ? res.bundle
      : (res as Extract<RenderResponse, { result: RenderResult }>).result
);

type Req = RenderRequest extends infer R
  ? R extends unknown
    ? Omit<R, "id">
    : never
  : never;

/** Off the main thread when there is a worker, in a later task when there is not, so callers always get a promise. */
function compute(req: Req): Promise<Out> {
  return (
    link.request((w, id) => w.postMessage({ ...req, id })) ??
    new Promise<Out>((resolve, reject) => {
      setTimeout(() => {
        try {
          resolve(runRequest({ ...req, id: 0 } as RenderRequest));
        } catch (err) {
          reject(err as Error);
        }
      }, 0);
    })
  );
}

function run(req: Req, key: string): Promise<Out> {
  const hit = cache.get(key);
  if (hit) {
    return Promise.resolve(hit);
  }
  const open = inflight.get(key);
  if (open) {
    return open;
  }
  const p = compute(req).then((r) => {
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

/** The project's master as it is now, and a key for it: a render made under another master is another render. */
const masterNow = (): RenderMaster => ({ ...project.project.master });
const masterKey = (m: RenderMaster): string => `${m.volume}:${m.limiter}`;

/* ----- how long sounds really last ----- */
const lengths = new Map<string, number>();
const LENGTHS_MAX = 500;
const lengthListeners = new Set<() => void>();

function rememberLength(json: string, r: RenderResult): void {
  const seconds = r.frames / r.sampleRate;
  if (lengths.get(json) === seconds) {
    return;
  }
  lengths.delete(json);
  lengths.set(json, seconds);
  if (lengths.size > LENGTHS_MAX) {
    lengths.delete(lengths.keys().next().value as string);
  }
  for (const fn of lengthListeners) {
    fn();
  }
}

/** How long this exact sound lasted the last time it was rendered, or null before the first render. */
export const renderedSeconds = (sfx: Sfx): number | null =>
  lengths.get(JSON.stringify(sfx)) ?? null;

/** How long to treat a sound as playing: its last render, or what the envelope asks for until there is one. */
export const playLength = (sfx: Sfx): number =>
  renderedSeconds(sfx) ??
  sfx.envelope.attack + sfx.envelope.sustain + sfx.envelope.decay;

/** "0.42s" for a rendered length, nothing before the first render. */
export const lengthLabel = (seconds: number | null): string =>
  seconds === null ? "" : `${seconds.toFixed(2)}s`;

/** Called whenever a sound's rendered length is new or changed (a sidebar row, a pad). */
export function onLengthChange(fn: () => void): () => void {
  lengthListeners.add(fn);
  return () => lengthListeners.delete(fn);
}

export function renderSfxAsync(sfx: Sfx, rate = 44_100): Promise<RenderResult> {
  const json = JSON.stringify(sfx);
  const master = masterNow();
  return (
    run(
      { kind: "sfx", master, rate, sfx },
      `sfx:${rate}:${masterKey(master)}:${json}`
    ) as Promise<RenderResult>
  ).then((r) => {
    rememberLength(json, r);
    return r;
  });
}

export const renderSongAsync = (
  song: Song,
  instruments: Record<string, Instrument>,
  rate = 44_100,
  stems = false
): Promise<RenderResult> => {
  const master = masterNow();
  return run(
    { instruments, kind: "song", master, rate, song, stems },
    `song:${rate}:${stems}:${masterKey(master)}:${JSON.stringify([song, instruments])}`
  ) as Promise<RenderResult>;
};

/** Render, analyse and draw the analysis images, all in the worker. */
export function analyzeAsync(
  source: Source,
  file: string,
  width = 1100,
  rate = 44_100
): Promise<AnalysisBundle> {
  const master = masterNow();
  const key = `ana:${rate}:${width}:${masterKey(master)}:${file}:${JSON.stringify(source)}`;
  // the images are big, so they are not kept in the cache
  return (
    run(
      { file, kind: "analysis", master, rate, source, width },
      key
    ) as Promise<AnalysisBundle>
  ).then((b) => {
    cache.delete(key);
    return b;
  });
}
