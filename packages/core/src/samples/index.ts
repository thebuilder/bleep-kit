// biome-ignore-all lint/performance/noBarrelFile: public entry of the sample generators
import type { GeneratedSample, SampleGeneratorId } from "../types.ts";
import { runGenerator } from "./generators.ts";
import { SAMPLE_SPECS } from "./specs.ts";

export const SAMPLE_GENERATORS = SAMPLE_SPECS;

/** Synthesize a sample deterministically: same generator, params, seed and rate give the same data. */
export function generateSample(
  gen: SampleGeneratorId,
  params: Record<string, number>,
  seed: number,
  sampleRate: number
): GeneratedSample {
  return runGenerator(gen, params, seed, sampleRate);
}
