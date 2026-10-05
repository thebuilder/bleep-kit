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

export type RenderRequest =
  | { id: number; kind: "sfx"; sfx: Sfx; rate: number }
  | {
      id: number;
      kind: "song";
      song: Song;
      instruments: Record<string, Instrument>;
      rate: number;
      stems: boolean;
    }
  | { id: number; kind: "note"; inst: Instrument; note: number; rate: number }
  | {
      id: number;
      kind: "analysis";
      source: Source;
      rate: number;
      file: string;
      width: number;
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

function renderSource(s: Source, rate: number, stems: boolean): RenderResult {
  if (s.type === "sfx") {
    return renderSfx(s.sfx, { sampleRate: rate });
  }
  if (s.type === "song") {
    return renderSong(s.song, s.instruments, { sampleRate: rate, stems });
  }
  return renderInstrumentNote(s.inst, s.note, { sampleRate: rate });
}

export function runRequest(req: RenderRequest): RenderResult | AnalysisBundle {
  if (req.kind === "sfx") {
    return renderSfx(req.sfx, { sampleRate: req.rate });
  }
  if (req.kind === "song") {
    return renderSong(req.song, req.instruments, {
      sampleRate: req.rate,
      stems: req.stems,
    });
  }
  if (req.kind === "note") {
    return renderInstrumentNote(req.inst, req.note, { sampleRate: req.rate });
  }
  const result = renderSource(req.source, req.rate, req.source.type === "song");
  const analysis = analyze(result, { file: req.file });
  const opts = { width: req.width };
  const safe = <T>(fn: (() => T) | undefined): T | null => {
    try {
      return fn ? fn() : null;
    } catch {
      return null;
    }
  };
  const wf = waveformImage;
  const sg = spectrogramImage;
  const sc = scopesImage;
  const images = {
    scopes:
      req.source.type === "song"
        ? safe(sc ? () => sc(result, { ...opts, title: req.file }) : undefined)
        : null,
    spectrogram: safe(
      sg ? () => sg(result, { ...opts, title: req.file }) : undefined
    ),
    waveform: safe(
      wf ? () => wf(result, { ...opts, title: req.file }) : undefined
    ),
  };
  return {
    analysis,
    images,
    result: images.waveform && images.spectrogram ? null : result,
  };
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<RenderRequest>) => void) | null;
  postMessage(m: unknown, t?: Transferable[]): void;
  document?: unknown;
};
if (
  typeof scope.document === "undefined" &&
  typeof scope.postMessage === "function"
) {
  scope.onmessage = (e) => {
    try {
      const out = runRequest(e.data);
      const transfer: Transferable[] = [];
      if ("bundle" in out || "analysis" in out) {
        const b = out as AnalysisBundle;
        for (const img of Object.values(b.images)) {
          if (img) {
            transfer.push(img.data.buffer);
          }
        }
        for (const c of b.result?.channels ?? []) {
          transfer.push(c.buffer);
        }
        scope.postMessage(
          { bundle: b, id: e.data.id } satisfies RenderResponse,
          transfer
        );
        return;
      }
      const result = out as RenderResult;
      for (const c of result.channels) {
        transfer.push(c.buffer);
      }
      for (const s of result.stems ?? []) {
        transfer.push(s.buffer);
      }
      scope.postMessage(
        { id: e.data.id, result } satisfies RenderResponse,
        transfer
      );
    } catch (err) {
      scope.postMessage({
        error: (err as Error).message,
        id: e.data.id,
      } satisfies RenderResponse);
    }
  };
}
