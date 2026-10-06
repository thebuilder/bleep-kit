/* Performance budget (architecture section 3.11): a genesis song (6 FM voices and 4 PSG voices) plus 8 sfx voices at
   48 kHz must cost under 0.66 ms per 128-frame block (25% of one core). Run with
   `pnpm --filter @bleepkit/core exec vitest bench --run --reporter=verbose` (the verbose reporter prints the console).

   The workload runs in a child Node process, not inside Vitest. Under Vitest every import between source files is a
   module runner getter (`sinCycles`, `dbToAmp` and friends are read per sample), which Vitest itself warns "can make
   results unreliable": measured here, the same workload costs about 8 times more per block inside the runner than in
   plain Node, so a number from inside it says nothing about the 0.66 ms budget. The worklet runs bundled code with no
   such getters, and so does a plain Node process. Node 22.18 or newer runs the .ts sources directly. */

import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";

const BUDGET_MS = 0.66;
const CONFIG = {
  block: 128,
  blocksPerIteration: 128,
  iterations: 40,
  sampleRate: 48_000,
  sfxVoices: 8,
  warmup: 10,
};

const SRC = new URL("../src/index.ts", import.meta.url).href;
const HELPERS = new URL("./helpers.ts", import.meta.url).href;

/* The child's program: set up the genesis demo with the 8 sfx voices loaded, then time `iterations` runs of
   `blocksPerIteration` blocks, each starting by triggering all 8 voices (the worst case: every voice sounding) or not
   (the song alone). The peak of a final untimed pass proves the synth was making sound while it was timed. */
const CHILD = `
import { createSynth } from ${JSON.stringify(SRC)};
import { fixtureDemo } from ${JSON.stringify(HELPERS)};
const c = ${JSON.stringify(CONFIG)};
function setup() {
  const d = fixtureDemo("genesis");
  const synth = createSynth({ sampleRate: c.sampleRate, sfxVoices: c.sfxVoices });
  synth.loadSong(d.song, d.instruments);
  for (let i = 0; i < c.sfxVoices; i += 1) synth.loadSfx("sfx" + i, d.sfx);
  synth.play({ loop: true });
  return synth;
}
const left = new Float32Array(c.block);
const right = new Float32Array(c.block);
const events = [];
function blocks(synth, n) {
  let peak = 0;
  for (let b = 0; b < n; b += 1) {
    synth.process(left, right, c.block, events);
    events.length = 0;
    for (let i = 0; i < c.block; i += 1) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  return peak;
}
function measure(withSfx) {
  const synth = setup();
  const perBlock = [];
  for (let it = 0; it < c.warmup + c.iterations; it += 1) {
    const t0 = performance.now();
    if (withSfx) {
      for (let i = 0; i < c.sfxVoices; i += 1) synth.trigger("sfx" + i, { pan: (i - 3.5) / 4, seed: i + 1, velocity: 1 });
    }
    for (let b = 0; b < c.blocksPerIteration; b += 1) {
      synth.process(left, right, c.block, events);
      events.length = 0;
    }
    const t1 = performance.now();
    if (it >= c.warmup) perBlock.push((t1 - t0) / c.blocksPerIteration);
  }
  perBlock.sort((a, b) => a - b);
  const at = (q) => perBlock[Math.min(perBlock.length - 1, Math.floor(q * perBlock.length))];
  return { median: at(0.5), min: perBlock[0], p90: at(0.9), peak: blocks(synth, 64) };
}
console.log(JSON.stringify({ songOnly: measure(false), songPlusSfx: measure(true) }));
`;

interface Stats {
  median: number;
  min: number;
  p90: number;
  peak: number;
}

test("genesis song plus 8 sfx voices, per 128-frame block, in plain Node", () => {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", CHILD],
    {
      encoding: "utf8",
      maxBuffer: 1 << 20,
      stdio: ["ignore", "pipe", "inherit"],
    }
  );
  const { songOnly, songPlusSfx } = JSON.parse(out) as {
    songOnly: Stats;
    songPlusSfx: Stats;
  };
  const line = (label: string, s: Stats) =>
    `${label} median ${s.median.toFixed(3)} ms, min ${s.min.toFixed(3)} ms, p90 ${s.p90.toFixed(3)} ms per block`;
  // other work on the machine only ever adds time, so the minimum is the figure that survives a busy machine
  const verdict = (ms: number) => (ms <= BUDGET_MS ? "within" : "OVER");
  console.log(
    `${line("song plus 8 sfx:", songPlusSfx)} (budget ${BUDGET_MS} ms: ${verdict(
      songPlusSfx.median
    )} at the median, ${verdict(songPlusSfx.min)} at the minimum; judge on an idle machine)`
  );
  console.log(line("song only:      ", songOnly));
  // a silent synth would time an idle engine: both runs must have been producing sound
  expect(songOnly.peak).toBeGreaterThan(0.01);
  expect(songPlusSfx.peak).toBeGreaterThan(0.01);
});
