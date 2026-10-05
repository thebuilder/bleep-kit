/* The main-thread side of the worklet protocol (section 5): loads the module, wraps the AudioWorkletNode in typed
   send/on, tracks the engine clock for `nowFrame()`, and feeds a ScopeReader from shared memory or posted copies. */

import {
  type FromWorklet,
  SCOPE_FRAMES,
  type ScopeReader,
  type ToWorklet,
} from "@bleepkit/core";
import { PROCESSOR_NAME } from "./protocol.ts";
import {
  createRingReader,
  MAX_SCOPE_CHANNELS,
  PostedRings,
  sharedRingSource,
  sharedScopeBytes,
} from "./scope.ts";
import type { ClockMessage } from "./worklet/engine.ts";

export type { ClockMessage } from "./worklet/engine.ts";

const READY_TIMEOUT_MS = 8000;

export interface EngineNodeOptions {
  /** Ring size in frames, default SCOPE_FRAMES. */
  scopeFrames?: number;
  /** Feed `scopes`. Default true; turn off for a game that never draws scopes (saves the posted copies). */
  scopes?: boolean;
  /** Sfx voices of the synth, default 8. */
  sfxVoices?: number;
  /** Use a SharedArrayBuffer for scopes when the page is cross-origin isolated. Default true. */
  shared?: boolean;
  /** URL of the bundled worklet. Default: the file next to this package's sources (`../worklet/`). */
  workletUrl?: string | URL;
}

export interface EngineNode {
  /** Average share of block time spent in the engine, 0 to 1 (more when overloaded); 0 until the first clock. */
  cpuLoad: () => number;
  dispose: () => void;
  /** AudioContext time at which `frame` is audible, given the clock pair of an `events` message (or the last clock). */
  frameToTime: (
    frame: number,
    anchor?: { clockFrame: number; clockTime: number }
  ) => number;
  /** The newest `clock` message, or null before the first. */
  lastClock: () => ClockMessage | null;
  node: AudioWorkletNode;
  /** Engine frame that is playing out of the speakers right now (clock message + currentTime + outputLatency). */
  nowFrame: () => number;
  on: (handler: (msg: FromWorklet) => void) => () => void;
  /** Seconds between rendering a frame and hearing it. */
  outputLatency: () => number;
  /** Sample rate the engine runs at (the context's). */
  readonly sampleRate: number;
  scopes: ScopeReader;
  send: (msg: ToWorklet) => void;
}

interface LatencyContext {
  baseLatency?: number;
  outputLatency?: number;
}

export function contextLatency(ctx: BaseAudioContext): number {
  const l = ctx as BaseAudioContext & LatencyContext;
  if (typeof l.outputLatency === "number" && l.outputLatency > 0) {
    return l.outputLatency;
  }
  return typeof l.baseLatency === "number" ? l.baseLatency : 0;
}

function defaultWorkletUrl(): URL {
  return new URL("../worklet/bleepkit-worklet.js", import.meta.url);
}

function canShare(): boolean {
  const g = globalThis as { crossOriginIsolated?: boolean };
  return (
    g.crossOriginIsolated === true && typeof SharedArrayBuffer === "function"
  );
}

export async function createEngineNode(
  ctx: BaseAudioContext,
  opts: EngineNodeOptions = {}
): Promise<EngineNode> {
  const url = opts.workletUrl ?? defaultWorkletUrl();
  try {
    await ctx.audioWorklet.addModule(url instanceof URL ? url.href : url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not load the Bleepkit worklet from ${String(url)}: ${reason}`,
      { cause: error }
    );
  }

  const wantScopes = opts.scopes !== false;
  const frames = opts.scopeFrames ?? SCOPE_FRAMES;
  const processorOptions: Record<string, unknown> = {
    scopeFrames: frames,
    scopes: wantScopes,
  };
  if (opts.sfxVoices !== undefined) {
    processorOptions.sfxVoices = opts.sfxVoices;
  }
  const node = new AudioWorkletNode(ctx, PROCESSOR_NAME, {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions,
  });

  const handlers = new Set<(msg: FromWorklet) => void>();
  const posted = new PostedRings(frames);
  let clock: ClockMessage | null = null;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  // the promise exists before the port is listened to, so an early `ready` cannot be missed
  let onReady: (rate: number) => void = () => undefined;
  let onFail: (error: Error) => void = () => undefined;
  const ready = new Promise<number>((resolve, reject) => {
    onReady = resolve;
    onFail = reject;
    node.onprocessorerror = () =>
      reject(new Error("the Bleepkit worklet failed to start"));
    timer = setTimeout(
      () => reject(new Error("the Bleepkit worklet did not answer")),
      READY_TIMEOUT_MS
    );
  });

  node.port.onmessage = (event: MessageEvent) => {
    const msg = event.data as FromWorklet | null;
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "ready") {
      onReady(msg.sampleRate);
    } else if (msg.type === "error") {
      onFail(new Error(msg.message));
    } else if (msg.type === "clock") {
      clock = msg;
    } else if (msg.type === "scope") {
      posted.write(msg.frame, msg.buffers, msg.master);
    }
    for (const handler of [...handlers]) {
      try {
        handler(msg);
      } catch {
        // a listener's bug must not stop the others or the clock
      }
    }
  };

  let sampleRate: number;
  try {
    sampleRate = await ready;
  } catch (error) {
    node.port.onmessage = null;
    node.disconnect();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const send = (msg: ToWorklet) => {
    if (!disposed) {
      node.port.postMessage(msg);
    }
  };

  let scopes: ScopeReader;
  if (wantScopes && opts.shared !== false && canShare()) {
    const buffer = new SharedArrayBuffer(
      sharedScopeBytes(frames, MAX_SCOPE_CHANNELS)
    );
    scopes = createRingReader(sharedRingSource(buffer, frames));
    send({ buffer, type: "setScopeBuffer" });
  } else {
    scopes = createRingReader(posted);
  }

  const latency = () => contextLatency(ctx);
  return {
    cpuLoad: () => clock?.load ?? 0,
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      handlers.clear();
      node.port.onmessage = null;
      node.disconnect();
      node.port.close();
    },
    frameToTime(frame, anchor) {
      const base = anchor ?? {
        clockFrame: clock?.frame ?? 0,
        clockTime: clock?.time ?? 0,
      };
      return (
        base.clockTime + (frame - base.clockFrame) / sampleRate + latency()
      );
    },
    lastClock: () => clock,
    node,
    nowFrame() {
      if (!clock) {
        return 0;
      }
      const elapsed = ctx.currentTime - clock.time - latency();
      return clock.frame + elapsed * sampleRate;
    },
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    outputLatency: latency,
    sampleRate,
    scopes,
    send,
  };
}
