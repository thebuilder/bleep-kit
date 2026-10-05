/* Encodes rendered audio to WAV, OGG or MP3 off the main thread (architecture section 8). OGG and MP3 come from the
   core encoders (wasm-media-encoders); when one is not available the result falls back to WAV and says so. */
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

/** A plain 16 bit PCM WAV, for when core's encoder is not there. */
export function simpleWav(r: RenderResult): Uint8Array {
  const n = r.frames;
  const ch = r.channels.length === 1 ? 1 : 2;
  const out = new Uint8Array(44 + n * ch * 2);
  const v = new DataView(out.buffer);
  const tag = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) {
      v.setUint8(o + i, s.charCodeAt(i));
    }
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + n * ch * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, r.sampleRate, true);
  v.setUint32(28, r.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  tag(36, "data");
  v.setUint32(40, n * ch * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, r.channels[c]?.[i] ?? 0));
      v.setInt16(o, Math.round(s * 32_767), true);
      o += 2;
    }
  }
  return out;
}

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
    bytes: encodeWav ? encodeWav(r, { id: req.name }) : simpleWav(r),
    used: "wav" as const,
  });
  if (req.format === "ogg" && encodeOgg) {
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
  if (req.format === "mp3" && encodeMp3) {
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
  return req.format === "wav"
    ? wav()
    : {
        ...wav(),
        note: `The ${req.format.toUpperCase()} encoder is not available here, wrote WAV`,
      };
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<EncodeRequest>) => void) | null;
  postMessage(m: unknown, t?: Transferable[]): void;
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
