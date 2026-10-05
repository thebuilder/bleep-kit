/* Calls the encode worker (or encodes on the main thread when there are no workers, as in tests). */

import type { RenderResult } from "./lib/contract.ts";
import { workerLink } from "./lib/worker-link.ts";
import type { EncodeRequest, EncodeResponse } from "./workers/encode.ts";
import { runEncode } from "./workers/encode.ts";

interface Encoded {
  bytes: Uint8Array;
  note?: string;
  used: "wav" | "ogg" | "mp3";
}

const link = workerLink<EncodeResponse, Encoded>(
  () =>
    new Worker(new URL("./workers/encode.ts", import.meta.url), {
      type: "module",
    }),
  "encode",
  (res) => {
    const { bytes, note, used } = res as Extract<
      EncodeResponse,
      { bytes: Uint8Array }
    >;
    return { bytes, used, ...(note ? { note } : {}) };
  }
);

export function encodeAudio(
  r: RenderResult,
  o: {
    format: "wav" | "ogg" | "mp3";
    quality: number;
    bitrate: number;
    name: string;
  }
): Promise<Encoded> {
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
  return (
    link.request((w, id) => {
      // copies, so the cached render stays usable
      const channels = r.channels.map((c) => c.slice());
      w.postMessage(
        { ...req, channels, id },
        channels.map((c) => c.buffer)
      );
    }) ?? runEncode({ ...req, channels: r.channels, id: 0 })
  );
}
