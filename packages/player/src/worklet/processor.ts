/* `@bleepkit/player/worklet`: registers the "bleepkit-engine" AudioWorkletProcessor. build-worklet.ts bundles this
   file and @bleepkit/core into one self-contained module for `audioWorklet.addModule`. */

import { PROCESSOR_NAME } from "../protocol.ts";
import {
  BleepkitEngine,
  type EngineEnv,
  type EngineOptions,
} from "./engine.ts";
import { defaultNow } from "./load-meter.ts";
import { createRealSynth } from "./synth-factory.ts";
import {
  getWorkletScope,
  type ProcessorBase,
  type ProcessorOptionsLike,
} from "./worklet-scope.ts";

const scope = getWorkletScope();

/** Outside a worklet (Node tests that did not stub the global) there is nothing to extend. */
class DetachedProcessor implements ProcessorBase {
  readonly port: ProcessorBase["port"] = {
    onmessage: null,
    postMessage() {
      // nobody is listening
    },
  };
  process(): boolean {
    return true;
  }
}

const Base = scope.AudioWorkletProcessor ?? DetachedProcessor;

function numberOption(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function engineOptions(source: unknown): EngineOptions {
  const out: EngineOptions = {};
  const sfxVoices = numberOption(source, "sfxVoices");
  const scopeFrames = numberOption(source, "scopeFrames");
  if (sfxVoices !== undefined) {
    out.sfxVoices = sfxVoices;
  }
  if (scopeFrames !== undefined) {
    out.scopeFrames = scopeFrames;
  }
  if (typeof source === "object" && source !== null) {
    const { scopes } = source as Record<string, unknown>;
    if (typeof scopes === "boolean") {
      out.scopes = scopes;
    }
  }
  return out;
}

export class BleepkitProcessor extends Base {
  /** The synth factory; tests replace it with a fake before constructing a processor. */
  static createSynth: EngineEnv["createSynth"] = createRealSynth;

  private readonly engine: BleepkitEngine;

  constructor(options?: ProcessorOptionsLike) {
    super(options);
    this.engine = new BleepkitEngine(
      this.port,
      {
        createSynth: BleepkitProcessor.createSynth,
        currentTime: () => scope.currentTime ?? 0,
        now: defaultNow(),
        sampleRate: scope.sampleRate ?? 48_000,
      },
      engineOptions(options?.processorOptions)
    );
    this.port.onmessage = (event) => {
      this.engine.handleMessage(event.data);
    };
  }

  override process(
    _inputs: Float32Array[][],
    outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>
  ) {
    return this.engine.process(outputs);
  }
}

if (typeof scope.registerProcessor === "function") {
  scope.registerProcessor(PROCESSOR_NAME, BleepkitProcessor);
}
