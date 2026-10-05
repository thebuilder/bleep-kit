/* Performance budget (architecture section 3.11): a genesis song (6 FM voices and 4 PSG voices) plus 8 sfx voices at
   48 kHz must cost under 0.66 ms per 128-frame block (25% of one core). Run with `pnpm --filter @bleepkit/core exec vitest bench --run`.
   Each iteration renders BLOCKS blocks, so the per-block cost is the reported mean divided by BLOCKS. */

import { test } from "vitest";
import type { EngineEvent } from "../src/index.ts";
import { createSynth } from "../src/index.ts";
import { fixtureDemo } from "./helpers.ts";

const SAMPLE_RATE = 48_000;
const BLOCK = 128;
const BLOCKS = 128;
const SFX_VOICES = 8;
const RUN = { time: 2000, warmupTime: 500 };

function setup() {
  const d = fixtureDemo("genesis");
  const synth = createSynth({ sampleRate: SAMPLE_RATE, sfxVoices: SFX_VOICES });
  synth.loadSong(d.song, d.instruments);
  for (let i = 0; i < SFX_VOICES; i += 1) {
    synth.loadSfx(`sfx${i}`, d.sfx);
  }
  synth.play({ loop: true });
  return synth;
}

const left = new Float32Array(BLOCK);
const right = new Float32Array(BLOCK);
const events: EngineEvent[] = [];

function runBlocks(synth: ReturnType<typeof setup>): void {
  for (let b = 0; b < BLOCKS; b += 1) {
    synth.process(left, right, BLOCK, events);
    events.length = 0;
  }
}

test("genesis song plus 8 sfx voices", async ({ bench }) => {
  const withSfx = setup();
  const songOnly = setup();
  const a = await bench("song plus 8 sfx", () => {
    for (let i = 0; i < SFX_VOICES; i += 1) {
      withSfx.trigger(`sfx${i}`, {
        pan: (i - 3.5) / 4,
        seed: i + 1,
        velocity: 1,
      });
    }
    runBlocks(withSfx);
  }).run(RUN);
  const b = await bench("song only", () => runBlocks(songOnly)).run(RUN);
  const perBlock = (ms: number) => (ms / BLOCKS).toFixed(3);
  console.log(
    `song plus 8 sfx: mean ${perBlock(a.latency.mean)} ms per block, p99 ${perBlock(a.latency.p99)} ms (budget 0.66)`
  );
  console.log(
    `song only:       mean ${perBlock(b.latency.mean)} ms per block, p99 ${perBlock(b.latency.p99)} ms`
  );
});
