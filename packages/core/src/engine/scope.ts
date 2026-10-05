/* Scope rings (section 5.3): the last `frames` samples of every channel stem and of the master, written each block.
   Layout in shared memory: [head: u32][channels * frames: f32][master L: frames f32][master R: frames f32]. */

import type { ScopeReader, ScopeRings } from "../types.ts";
import { SCOPE_FRAMES } from "../types.ts";

const SCOPE_CHANNELS = 10;

/** Bytes a shared scope buffer needs for the given ring size. */
export function scopeBufferBytes(
  frames: number = SCOPE_FRAMES,
  channels: number = SCOPE_CHANNELS
): number {
  return 4 + 4 * frames * (channels + 2);
}

export function createScopeRings(
  frames: number,
  buffer: SharedArrayBuffer | null,
  channels: number = SCOPE_CHANNELS
): ScopeRings {
  if (buffer && buffer.byteLength >= scopeBufferBytes(frames, channels)) {
    const head = new Uint32Array(buffer, 0, 1);
    const rings: Float32Array[] = [];
    for (let c = 0; c < channels; c += 1) {
      rings.push(new Float32Array(buffer, 4 + c * frames * 4, frames));
    }
    const base = 4 + channels * frames * 4;
    const master: [Float32Array, Float32Array] = [
      new Float32Array(buffer, base, frames),
      new Float32Array(buffer, base + frames * 4, frames),
    ];
    return { channels: rings, frames, head, master };
  }
  const rings: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    rings.push(new Float32Array(frames));
  }
  return {
    channels: rings,
    frames,
    head: new Uint32Array(1),
    master: [new Float32Array(frames), new Float32Array(frames)],
  };
}

/** Write n frames of one stream into its ring at the current head (the head itself moves in advanceScopeHead). */
export function writeRing(
  ring: Float32Array,
  src: Float32Array,
  n: number,
  head: number
): void {
  const size = ring.length;
  let pos = head;
  for (let i = 0; i < n; i += 1) {
    ring[pos] = src[i] ?? 0;
    pos += 1;
    if (pos >= size) {
      pos = 0;
    }
  }
}

export function zeroRing(ring: Float32Array, n: number, head: number): void {
  const size = ring.length;
  let pos = head;
  for (let i = 0; i < n; i += 1) {
    ring[pos] = 0;
    pos += 1;
    if (pos >= size) {
      pos = 0;
    }
  }
}

export function advanceScopeHead(rings: ScopeRings, n: number): void {
  rings.head[0] = ((rings.head[0] ?? 0) + n) % rings.frames;
}

/**
 * Reads rings into one reused buffer. channel -1 and -2 are master left and right. Absolute engine frame f lives at
 * ring index f modulo the ring size: `at(channel, frame, frames)` copies the `frames` samples that start at `frame`
 * (the start of the window, not its end), `latest` the newest `frames` samples.
 */
export function createScopeReader(
  rings: ScopeRings,
  _sampleRate: number
): ScopeReader {
  const size = rings.frames;
  const out = new Float32Array(size);
  const ringFor = (channel: number): Float32Array | null => {
    if (channel === -1) {
      return rings.master[0];
    }
    if (channel === -2) {
      return rings.master[1];
    }
    return rings.channels[channel] ?? null;
  };
  const copy = (
    ring: Float32Array | null,
    start: number,
    frames: number
  ): Float32Array => {
    const n = Math.max(0, Math.min(size, Math.floor(frames)));
    const view = out.subarray(0, n);
    if (!ring) {
      view.fill(0);
      return view;
    }
    let pos = ((start % size) + size) % size;
    for (let i = 0; i < n; i += 1) {
      view[i] = ring[pos] ?? 0;
      pos += 1;
      if (pos >= size) {
        pos = 0;
      }
    }
    return view;
  };
  return {
    at(channel, frame, frames) {
      return copy(ringFor(channel), Math.floor(frame), frames);
    },
    latest(channel, frames) {
      const n = Math.max(0, Math.min(size, Math.floor(frames)));
      return copy(ringFor(channel), (rings.head[0] ?? 0) - n, n);
    },
  };
}
