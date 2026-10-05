/* Calls the encode worker (or encodes on the main thread when there are no workers, as in tests). */
import type { RenderResult } from "./lib/contract.ts";
import type { EncodeRequest, EncodeResponse } from "./workers/encode.ts";
import { runEncode } from "./workers/encode.ts";

let worker: Worker | null | undefined;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (r: {
      bytes: Uint8Array;
      used: "wav" | "ogg" | "mp3";
      note?: string;
    }) => void;
    reject: (e: Error) => void;
  }
>();

function getWorker(): Worker | null {
  if (worker !== undefined) {
    return worker;
  }
  try {
    if (typeof Worker === "undefined") {
      worker = null;
    } else {
      worker = new Worker(new URL("./workers/encode.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (e: MessageEvent<EncodeResponse>) => {
        const p = pending.get(e.data.id);
        if (!p) {
          return;
        }
        pending.delete(e.data.id);
        if ("error" in e.data) {
          p.reject(new Error(e.data.error));
        } else {
          p.resolve({
            bytes: e.data.bytes,
            used: e.data.used,
            ...(e.data.note ? { note: e.data.note } : {}),
          });
        }
      };
      worker.onerror = () => {
        worker = null;
        for (const [, p] of pending) {
          p.reject(new Error("encode worker failed"));
        }
        pending.clear();
      };
    }
  } catch {
    worker = null;
  }
  return worker;
}

export function encodeAudio(
  r: RenderResult,
  o: {
    format: "wav" | "ogg" | "mp3";
    quality: number;
    bitrate: number;
    name: string;
  }
): Promise<{ bytes: Uint8Array; used: "wav" | "ogg" | "mp3"; note?: string }> {
  const req: Omit<EncodeRequest, "id" | "channels"> = {
    bitrate: o.bitrate,
    format: o.format,
    frames: r.frames,
    loopEnd: r.loopEnd ?? null,
    loopStart: r.loopStart ?? null,
    name: o.name,
    quality: o.quality,
    sampleRate: r.sampleRate,
  };
  const w = getWorker();
  if (!w) {
    return runEncode({ ...req, channels: r.channels, id: 0 });
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { reject, resolve });
    // copies, so the cached render stays usable
    const channels = r.channels.map((c) => c.slice());
    w.postMessage(
      { ...req, channels, id },
      channels.map((c) => c.buffer)
    );
  });
}
