/* What the files and synth backends get from the player. */

import type { EventDispatcher } from "./dispatcher.ts";
import type { AudioManifest } from "./types.ts";

export interface BackendShared {
  /** Register a function the player's timer calls with the context time; it returns false when it is finished. */
  addPumper: (fn: (now: number) => boolean) => void;
  ctx: AudioContext;
  dispatcher: EventDispatcher;
  /** Seconds between rendering and hearing. */
  latency: () => number;
  manifest: AudioManifest;
  musicBus: GainNode;
  nextHandle: () => number;
  report: (error: Error) => void;
  sfxBus: GainNode;
  /** Make sure the timer runs (call after queueing events). */
  wake: () => void;
}
