/* Main-thread scope reading (sections 4.3 and 5.3). Two feeds, one reader: rings in a SharedArrayBuffer the synth
   writes, or rings the main thread fills from `scope` messages. In both, absolute engine frame f lives at ring
   index f modulo the ring size, and `head` is the write position, so `latest` and `at` are plain wrapped copies. */

import type { ScopeReader } from "@bleepkit/core";

/** Channels the shared layout has room for (the genesis profile's 10, section 5.3). */
export const MAX_SCOPE_CHANNELS = 10;

export interface RingSource {
  /**
   * The absolute engine frame just after the newest sample that really is in the rings, when the feed lags the
   * engine (posted copies arrive in blocks, a message late). A window that would end after it is moved back so it
   * never reads frames the ring has not received yet (they would hold sound from a whole ring ago). Shared memory
   * is written every block, so it has none.
   */
  end?: () => number;
  readonly frames: number;
  /** Frames written so far modulo `frames`. */
  head: () => number;
  /** channel >= 0: a song channel, -1 master left, -2 master right. null when the channel has no ring. */
  ring: (channel: number) => Float32Array | null;
}

/** Bytes of a shared scope buffer: [head u32][channels * frames f32][master L][master R]. */
export function sharedScopeBytes(
  frames: number,
  maxChannels = MAX_SCOPE_CHANNELS
): number {
  return 4 + 4 * frames * (maxChannels + 2);
}

export function sharedRingSource(
  buffer: SharedArrayBuffer,
  frames: number,
  maxChannels = MAX_SCOPE_CHANNELS
): RingSource {
  const head = new Uint32Array(buffer, 0, 1);
  const rings: Float32Array[] = [];
  for (let i = 0; i < maxChannels + 2; i += 1) {
    rings.push(new Float32Array(buffer, 4 + 4 * frames * i, frames));
  }
  return {
    frames,
    head: () => (head[0] ?? 0) % frames,
    ring(channel) {
      if (channel === -1) {
        return rings[maxChannels] ?? null;
      }
      if (channel === -2) {
        return rings[maxChannels + 1] ?? null;
      }
      return channel >= 0 && channel < maxChannels
        ? (rings[channel] ?? null)
        : null;
    },
  };
}

/** Rings kept on the main thread and filled from posted copies. */
export class PostedRings implements RingSource {
  readonly frames: number;
  private readonly channels: Float32Array[] = [];
  private readonly master: [Float32Array, Float32Array];
  private position = 0;
  private written = 0;

  constructor(frames: number) {
    this.frames = frames;
    this.master = [new Float32Array(frames), new Float32Array(frames)];
  }

  head(): number {
    return this.position;
  }

  end(): number {
    return this.written;
  }

  ring(channel: number): Float32Array | null {
    if (channel === -1) {
      return this.master[0];
    }
    if (channel === -2) {
      return this.master[1];
    }
    return this.channels[channel] ?? null;
  }

  /** `frame` is the engine frame just after the last sample of the copies. */
  write(
    frame: number,
    buffers: readonly Float32Array[],
    master: readonly Float32Array[]
  ): void {
    for (let i = 0; i < buffers.length; i += 1) {
      const data = buffers[i];
      if (!data) {
        continue;
      }
      let ring = this.channels[i];
      if (!ring) {
        ring = new Float32Array(this.frames);
        this.channels[i] = ring;
      }
      this.copyIn(ring, frame, data);
    }
    for (let i = 0; i < 2; i += 1) {
      const data = master[i];
      const ring = this.master[i];
      if (data && ring) {
        this.copyIn(ring, frame, data);
      }
    }
    this.position = ((frame % this.frames) + this.frames) % this.frames;
    this.written = Math.max(this.written, frame);
  }

  private copyIn(ring: Float32Array, frame: number, data: Float32Array): void {
    const size = this.frames;
    const length = Math.min(data.length, size);
    const skip = data.length - length;
    let index = (((frame - length) % size) + size) % size;
    for (let i = 0; i < length; i += 1) {
      ring[index] = data[skip + i] ?? 0;
      index = index + 1 === size ? 0 : index + 1;
    }
  }
}

/** A reader over any ring source. Each channel has its own reused output buffer, valid until the next call for it. */
export function createRingReader(source: RingSource): ScopeReader {
  const outputs = new Map<number, Float32Array>();

  const output = (channel: number, frames: number): Float32Array => {
    let out = outputs.get(channel);
    if (!out || out.length !== frames) {
      out = new Float32Array(frames);
      outputs.set(channel, out);
    }
    return out;
  };

  const count = (frames: number) =>
    Math.max(1, Math.min(Math.floor(frames), source.frames));

  const copy = (channel: number, from: number, n: number) => {
    // a feed that lags the engine: show the newest sound it has, not the stale frames after it
    const end = source.end?.();
    const start = end === undefined ? from : Math.min(from, end - n);
    const out = output(channel, n);
    const ring = source.ring(channel);
    if (!ring) {
      out.fill(0);
      return out;
    }
    const size = source.frames;
    let index = ((start % size) + size) % size;
    for (let i = 0; i < n; i += 1) {
      out[i] = ring[index] ?? 0;
      index = index + 1 === size ? 0 : index + 1;
    }
    return out;
  };

  return {
    at: (channel, frame, frames) => copy(channel, frame, count(frames)),
    latest: (channel, frames) => {
      const n = count(frames);
      return copy(channel, source.head() - n, n);
    },
  };
}
