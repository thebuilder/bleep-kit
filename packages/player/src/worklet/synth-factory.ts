/* The one place the worklet bundle reaches into the engine. Tests hand the processor a fake factory instead. */

import type { Synth, SynthOptions } from "@bleepkit/core";
import { createSynth } from "@bleepkit/core";

export function createRealSynth(opts: SynthOptions): Synth {
  return createSynth(opts);
}
