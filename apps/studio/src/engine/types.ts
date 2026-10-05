/* What the studio needs from an engine node: the shape of @bleepkit/player's EngineNode (section 5.1), which the
   fake engine in src/dev/fake-engine.ts implements too. */
import type { FromWorklet, ToWorklet } from "../lib/contract.ts";

export interface ScopeReaderLike {
  /** The samples that were playing at engine frame `frame`, `frames` long. */
  at: (channel: number, frame: number, frames: number) => Float32Array;
  /** The last `frames` samples of a channel (-1 and -2 are master left and right). */
  latest: (channel: number, frames: number) => Float32Array;
}

export interface EngineNodeLike {
  dispose: () => void;
  node?: unknown;
  /** Engine frame that is playing out of the speakers right now. */
  nowFrame: () => number;
  on: (handler: (msg: FromWorklet) => void) => () => void;
  scopes: ScopeReaderLike;
  send: (msg: ToWorklet) => void;
}
