/* Renders sounds off the main thread, so the UI never stalls while a waveform is redrawn (section 11.2). The same
   worker also analyses a render and draws the three analysis images, which are slower. */
import type { Instrument, RenderResult, Sfx, Song } from "../lib/contract.ts";
import {
  type Analysis,
  analyze,
  type PixelImage,
  renderInstrumentNote,
  renderSfx,
  renderSong,
  scopesImage,
  spectrogramImage,
  waveformImage,
} from "../lib/core.ts";

export type Source =
  | { type: "sfx"; sfx: Sfx }
  | { type: "song"; song: Song; instruments: Record<string, Instrument> }
  | { type: "note"; inst: Instrument; note: number };

/** The project's master: its volume scales sfx renders, and its limiter setting applies to songs too. */
export interface RenderMaster {
  limiter: boolean;
  volume: number;
}

export type RenderRequest =
  | { id: number; kind: "sfx"; sfx: Sfx; rate: number; master: RenderMaster }
  | {
      id: number;
      kind: "song";
      song: Song;
      instruments: Record<string, Instrument>;
      rate: number;
      stems: boolean;
      master: RenderMaster;
    }
  | {
      id: number;
      kind: "analysis";
      source: Source;
      rate: number;
      file: string;
      width: number;
      master: RenderMaster;
    };

export interface AnalysisBundle {
  analysis: Analysis;
  images: {
    waveform: PixelImage | null;
    spectrogram: PixelImage | null;
    scopes: PixelImage | null;
  };
  /** Present only when the image functions are missing, so the page can draw its own. */
  result: RenderResult | null;
}

export type RenderResponse =
  | { id: number; result: RenderResult }
  | { id: number; bundle: AnalysisBundle }
  | { id: number; error: string };

function renderSource(
  s: Source,
  rate: number,
  master: RenderMaster
): RenderResult {
  const opts = { master, sampleRate: rate };
  if (s.type === "sfx") {
    return renderSfx(s.sfx, opts);
  }
  if (s.type === "song") {
    return renderSong(s.song, s.instruments, { ...opts, stems: true });
  }
  return renderInstrumentNote(s.inst, s.note, opts);
}

export function runRequest(req: RenderRequest): RenderResult | AnalysisBundle {
  if (req.kind === "sfx") {
    return renderSfx(req.sfx, { master: req.master, sampleRate: req.rate });
  }
  if (req.kind === "song") {
    return renderSong(req.song, req.instruments, {
      master: req.master,
      sampleRate: req.rate,
      stems: req.stems,
    });
  }
  const result = renderSource(req.source, req.rate, req.master);
  const analysis = analyze(result, { file: req.file });
  const opts = { width: req.width };
  const safe = <T>(fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  const images = {
    scopes:
      req.source.type === "song"
        ? safe(() => scopesImage(result, { ...opts, title: req.file }))
        : null,
    spectrogram: safe(() =>
      spectrogramImage(result, { ...opts, title: req.file })
    ),
    waveform: safe(() => waveformImage(result, { ...opts, title: req.file })),
  };
  return {
    analysis,
    images,
    result: images.waveform && images.spectrogram ? null : result,
  };
}

const isBundle = (out: RenderResult | AnalysisBundle): out is AnalysisBundle =>
  "analysis" in out;

/** The pixel and sample buffers an answer holds, handed over to the page instead of copied. */
function buffersOf(out: RenderResult | AnalysisBundle): Transferable[] {
  if (isBundle(out)) {
    return [
      ...Object.values(out.images).flatMap((img) =>
        img ? [img.data.buffer] : []
      ),
      ...(out.result?.channels ?? []).map((c) => c.buffer),
    ];
  }
  return [...out.channels, ...(out.stems ?? [])].map((c) => c.buffer);
}

/** Run a request and post the answer, or the error, tagged with the request's id. */
export function respond(
  req: RenderRequest,
  post: (message: RenderResponse, transfer?: Transferable[]) => void
): void {
  try {
    const out = runRequest(req);
    post(
      isBundle(out) ? { bundle: out, id: req.id } : { id: req.id, result: out },
      buffersOf(out)
    );
  } catch (err) {
    post({ error: (err as Error).message, id: req.id });
  }
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (m: unknown, t?: Transferable[]) => void;
  document?: unknown;
};
if (
  typeof scope.document === "undefined" &&
  typeof scope.postMessage === "function"
) {
  scope.onmessage = (e) => respond(e.data, scope.postMessage.bind(scope));
}
