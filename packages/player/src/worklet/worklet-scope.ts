/* The few AudioWorkletGlobalScope names the processor uses. lib.dom does not declare them, so they are described
   here and read from globalThis, which also lets tests stub them. */

export interface ProcessorOptionsLike {
  processorOptions?: unknown;
}

export interface ProcessorBase {
  readonly port: {
    postMessage: (message: unknown, transfer?: Transferable[]) => void;
    onmessage: ((event: { data: unknown }) => void) | null;
  };
  // biome-ignore lint/style/useConsistentMethodSignatures: this describes the base class, whose subclass overrides process() as a method (a property would make that a TS2425 error)
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

export type ProcessorBaseConstructor = new (
  options?: ProcessorOptionsLike
) => ProcessorBase;

export interface WorkletScope {
  AudioWorkletProcessor?: ProcessorBaseConstructor;
  currentTime?: number;
  registerProcessor?: (name: string, ctor: ProcessorBaseConstructor) => void;
  sampleRate?: number;
}

export function getWorkletScope(): WorkletScope {
  return globalThis as unknown as WorkletScope;
}
