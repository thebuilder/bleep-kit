import type { RenderResult } from "../types.ts";

/** Interleave a result's channels (L R L R ...). Works for any channel count. */
export function resultToInterleaved(r: RenderResult): Float32Array {
  const count = r.channels.length;
  const out = new Float32Array(r.frames * count);
  for (let c = 0; c < count; c += 1) {
    const src = r.channels[c];
    if (!src) {
      continue;
    }
    for (let i = 0; i < r.frames; i += 1) {
      out[i * count + c] = src[i] ?? 0;
    }
  }
  return out;
}

/** Split interleaved samples into a RenderResult (no events, no loop). `channels` is the interleave stride. */
export function interleavedToResult(
  data: Float32Array,
  channels: number,
  sampleRate: number
): RenderResult {
  const count = Math.max(1, Math.floor(channels));
  const frames = Math.floor(data.length / count);
  const planes: Float32Array[] = [];
  for (let c = 0; c < count; c += 1) {
    const plane = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      plane[i] = data[i * count + c] ?? 0;
    }
    planes.push(plane);
  }
  return { channels: planes, events: [], frames, sampleRate };
}

/** Average of all channels, as a new mono buffer of r.frames samples. */
export function mixToMono(r: RenderResult): Float32Array {
  const out = new Float32Array(r.frames);
  const count = r.channels.length;
  if (count === 0) {
    return out;
  }
  const [first] = r.channels;
  if (count === 1 && first) {
    out.set(first.subarray(0, r.frames));
    return out;
  }
  for (const plane of r.channels) {
    for (let i = 0; i < r.frames; i += 1) {
      out[i] = (out[i] ?? 0) + (plane[i] ?? 0);
    }
  }
  const inv = 1 / count;
  for (let i = 0; i < r.frames; i += 1) {
    out[i] = (out[i] ?? 0) * inv;
  }
  return out;
}
