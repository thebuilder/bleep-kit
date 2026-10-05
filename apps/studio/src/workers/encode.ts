/* Encodes rendered audio to WAV, OGG or MP3 off the main thread (architecture section 8). OGG and MP3 come from the
   core encoders (wasm-media-encoders); when one fails the result falls back to WAV and says so. */
import type { RenderResult } from "../lib/contract.ts";
import { encodeMp3, encodeOgg, encodeWav } from "../lib/core.ts";

export interface EncodeRequest {
  bitrate: number;
  channels: Float32Array[];
  format: "wav" | "ogg" | "mp3";
  frames: number;
  id: number;
  loopEnd: number | null;
  loopStart: number | null;
  name: string;
  quality: number;
  sampleRate: number;
}
export type EncodeResponse =
  | {
      id: number;
      bytes: Uint8Array;
      used: "wav" | "ogg" | "mp3";
      note?: string;
    }
  | { id: number; error: string };

export async function runEncode(
  req: EncodeRequest
): Promise<Omit<Extract<EncodeResponse, { bytes: Uint8Array }>, "id">> {
  const r: RenderResult = {
    channels: req.channels,
    events: [],
    frames: req.frames,
    sampleRate: req.sampleRate,
    ...(req.loopStart !== null && req.loopEnd !== null
      ? { loopEnd: req.loopEnd, loopStart: req.loopStart }
      : {}),
  };
  const wav = () => ({
    bytes: encodeWav(r, { id: req.name }),
    used: "wav" as const,
  });
  if (req.format === "ogg") {
    try {
      return {
        bytes: await encodeOgg(r, { quality: req.quality }),
        used: "ogg",
      };
    } catch (err) {
      return {
        ...wav(),
        note: `OGG encoding failed (${(err as Error).message}), wrote WAV`,
      };
    }
  }
  if (req.format === "mp3") {
    try {
      return {
        bytes: await encodeMp3(r, { bitrate: req.bitrate }),
        used: "mp3",
      };
    } catch (err) {
      return {
        ...wav(),
        note: `MP3 encoding failed (${(err as Error).message}), wrote WAV`,
      };
    }
  }
  return wav();
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
  postMessage: (m: unknown, t?: Transferable[]) => void;
  document?: unknown;
};
if (
  typeof scope.document === "undefined" &&
  typeof scope.postMessage === "function"
) {
  scope.onmessage = (e) => {
    runEncode(e.data)
      .then((out) =>
        scope.postMessage({ id: e.data.id, ...out } satisfies EncodeResponse, [
          out.bytes.buffer,
        ])
      )
      .catch((err: Error) =>
        scope.postMessage({
          error: err.message,
          id: e.data.id,
        } satisfies EncodeResponse)
      );
  };
}
