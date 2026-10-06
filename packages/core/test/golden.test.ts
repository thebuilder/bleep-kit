/* Golden hashes, determinism and block-size independence (architecture section 9). Run with UPDATE_GOLDEN=1 to rewrite
   test/golden/<id>.json after an intentional change to the sound. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RenderResult } from "../src/index.ts";
import {
  createSynth,
  ENGINE_VERSION,
  normalizeInstrument,
  renderInstrumentNote,
  renderSfx,
  renderSong,
} from "../src/index.ts";
import {
  cutSong,
  fixtureDemo,
  fixtureInstruments,
  fixtureJson,
  fixtureSfx,
  fixtureSong,
  hashChannels,
  peak,
  runSynth,
} from "./helpers.ts";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const RATES = [48_000, 44_100] as const;
const CHIPS = ["gameboy", "c64", "genesis", "adlib", "snes", "custom"] as const;
const INSTRUMENT_FILES = [
  "instrument-lead",
  "instrument-bass",
  "instrument-drums",
  "instrument-fm-bass",
  "instrument-snes-pluck",
] as const;
/** Every golden file there should be: nes is covered by the coin and the title song, the other chips by their demos. */
const GOLDEN_IDS: readonly string[] = [
  "sfx-coin",
  "song-title",
  ...CHIPS.flatMap((chip) => [`demo-${chip}`, `demo-${chip}-sfx`]),
  ...INSTRUMENT_FILES,
];

interface Entry {
  events: number;
  frames: number;
  hash: string;
}
/** What a golden file holds: the entries by sample rate, and the engine version they were made under. */
interface GoldenFile {
  engineVersion: string;
  renders: Record<string, Entry>;
}

function summarize(r: RenderResult): Entry {
  return {
    events: r.events.length,
    frames: r.frames,
    hash: hashChannels(r.channels),
  };
}

function readGolden(path: string): GoldenFile | null {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as GoldenFile)
    : null;
}

/** UPDATE_GOLDEN=1 rewrites a golden file, but not hashes that moved while ENGINE_VERSION stayed where it was. */
function writeGolden(id: string, path: string, now: GoldenFile): void {
  const had = readGolden(path);
  if (
    had &&
    had.engineVersion === ENGINE_VERSION &&
    JSON.stringify(had.renders) !== JSON.stringify(now.renders)
  ) {
    throw new Error(
      `golden ${id}.json: the sound changed but ENGINE_VERSION is still "${ENGINE_VERSION}". If the change is on purpose, bump ENGINE_VERSION in src/version.ts (it invalidates the renders in every project's out/), then run UPDATE_GOLDEN=1 again.`
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(now, null, 2)}\n`);
}

/** A whole song is seconds of DSP, so its hash is pinned at the default rate only; the rate itself is pinned by the
    sfx and instrument scenarios, which are cheap enough to render at both. */
const SONG_IDS: readonly string[] = [
  "song-title",
  ...CHIPS.map((chip) => `demo-${chip}`),
];
const ratesOf = (id: string): readonly number[] =>
  SONG_IDS.includes(id) ? [48_000] : RATES;

function checkGolden(id: string, make: (rate: number) => RenderResult): void {
  const path = `${GOLDEN}${id}.json`;
  const now: GoldenFile = { engineVersion: ENGINE_VERSION, renders: {} };
  for (const rate of ratesOf(id)) {
    const render = make(rate);
    // a hash of silence would pin nothing: every golden scenario has to make a sound
    expect(
      peak(render.channels),
      `${id} at ${rate} Hz is silent`
    ).toBeGreaterThan(0.01);
    now.renders[String(rate)] = summarize(render);
  }
  if (UPDATE) {
    writeGolden(id, path, now);
    return;
  }
  const want = readGolden(path);
  expect(want, `missing golden ${id}.json, run with UPDATE_GOLDEN=1`).not.toBe(
    null
  );
  const { engineVersion, renders } = want as GoldenFile;
  expect(
    engineVersion,
    `golden ${id}.json was written under ENGINE_VERSION "${engineVersion}" but src/version.ts says "${ENGINE_VERSION}". Whoever changed one has to change the other: regenerate with UPDATE_GOLDEN=1 after bumping ENGINE_VERSION on purpose, or restore the golden files.`
  ).toBe(ENGINE_VERSION);
  expect(
    now.renders,
    `golden ${id}.json: the sound changed but ENGINE_VERSION is still "${ENGINE_VERSION}". If it is on purpose, bump ENGINE_VERSION in src/version.ts, then run UPDATE_GOLDEN=1; if not, this is a regression.`
  ).toEqual(renders);
}

function bitEqual(a: RenderResult, b: RenderResult): void {
  expect(a.frames).toBe(b.frames);
  expect(a.channels).toHaveLength(2);
  for (let c = 0; c < 2; c += 1) {
    const x = a.channels[c] as Float32Array;
    const y = b.channels[c] as Float32Array;
    let same = x.length === y.length;
    for (let i = 0; same && i < x.length; i += 1) {
      if (!Object.is(x[i], y[i])) {
        same = false;
      }
    }
    expect(same).toBe(true);
  }
  expect(a.events).toEqual(b.events);
}

describe("golden files and ENGINE_VERSION", () => {
  const entry = { events: 1, frames: 10, hash: "00000001" };
  const file = (engineVersion: string, hash = entry.hash): GoldenFile => ({
    engineVersion,
    renders: { "48000": { ...entry, hash } },
  });

  it("every golden file records the engine version it was made under", () => {
    const stale = readdirSync(GOLDEN)
      .filter((name) => name.endsWith(".json"))
      .filter(
        (name) =>
          (readGolden(`${GOLDEN}${name}`) as GoldenFile).engineVersion !==
          ENGINE_VERSION
      );
    expect(
      stale,
      `golden files from another ENGINE_VERSION than "${ENGINE_VERSION}": regenerate them with UPDATE_GOLDEN=1 after bumping it on purpose`
    ).toEqual([]);
  });

  it("refuses to rewrite moved hashes under the same version, allows them under a bumped one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bleepkit-golden-"));
    try {
      const path = join(dir, "x.json");
      writeGolden("x", path, file(ENGINE_VERSION));
      // same hashes, same version: rewriting is harmless
      writeGolden("x", path, file(ENGINE_VERSION));
      // moved hash, same version: the sound changed without a bump
      expect(() =>
        writeGolden("x", path, file(ENGINE_VERSION, "00000002"))
      ).toThrow(/bump ENGINE_VERSION in src\/version\.ts/);
      expect(readGolden(path)).toEqual(file(ENGINE_VERSION));
      // a file from an older version may be replaced by the new hashes
      writeFileSync(path, JSON.stringify(file("0")));
      writeGolden("x", path, file(ENGINE_VERSION, "00000002"));
      expect(readGolden(path)).toEqual(file(ENGINE_VERSION, "00000002"));
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("there is one golden file per scenario below, no more and no fewer", () => {
    const files = readdirSync(GOLDEN)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length));
    expect(files.sort()).toEqual([...GOLDEN_IDS].sort());
  });

  it("no two scenarios share a hash, so none is a copy of another", () => {
    const owners = new Map<string, string>();
    for (const id of GOLDEN_IDS) {
      const golden = readGolden(`${GOLDEN}${id}.json`) as GoldenFile;
      for (const [rate, render] of Object.entries(golden.renders)) {
        const key = `${rate}:${render.hash}`;
        expect(owners.get(key), `${id} and ${owners.get(key)} at ${rate}`).toBe(
          undefined
        );
        owners.set(key, id);
      }
    }
    expect(owners.size).toBe(
      GOLDEN_IDS.reduce((n, id) => n + ratesOf(id).length, 0)
    );
  });
});

describe("golden renders", () => {
  it("sfx-coin", () => {
    const sfx = fixtureSfx();
    checkGolden("sfx-coin", (sampleRate) => renderSfx(sfx, { sampleRate }));
  });

  it("song-title", () => {
    const { song, instruments } = fixtureSong();
    checkGolden("song-title", (sampleRate) =>
      renderSong(song, instruments, { sampleRate, tail: 0.5 })
    );
  });

  for (const chip of CHIPS) {
    it(`demo-${chip} song`, () => {
      const d = fixtureDemo(chip);
      checkGolden(`demo-${chip}`, (sampleRate) =>
        renderSong(d.song, d.instruments, { sampleRate, tail: 0.5 })
      );
    });

    it(`demo-${chip} sfx`, () => {
      const d = fixtureDemo(chip);
      checkGolden(`demo-${chip}-sfx`, (sampleRate) =>
        renderSfx(d.sfx, { sampleRate })
      );
    });
  }

  for (const file of INSTRUMENT_FILES) {
    it(file, () => {
      const inst = normalizeInstrument(fixtureJson(`${file}.json`)).value;
      checkGolden(file, (sampleRate) =>
        renderInstrumentNote(inst, 57, {
          duration: 0.4,
          release: 0.3,
          sampleRate,
        })
      );
    });
  }
});

describe("determinism", () => {
  /** The title song cut to its first 16 rows: determinism does not need the whole song. */
  const shortTitle = () => {
    const { song, instruments } = fixtureSong();
    return { instruments, song: cutSong(song) };
  };

  it("renderSong twice is bit identical", () => {
    const { song, instruments } = shortTitle();
    bitEqual(
      renderSong(song, instruments, { tail: 0.25 }),
      renderSong(song, instruments, { tail: 0.25 })
    );
  });

  it("renderSfx twice is bit identical, for every chip", () => {
    bitEqual(renderSfx(fixtureSfx()), renderSfx(fixtureSfx()));
    for (const chip of CHIPS) {
      const d = fixtureDemo(chip);
      bitEqual(renderSfx(d.sfx), renderSfx(d.sfx));
    }
  });

  it("every chip's demo song renders identically twice", () => {
    for (const chip of CHIPS) {
      const d = fixtureDemo(chip);
      const song = cutSong(d.song, 8);
      bitEqual(
        renderSong(song, d.instruments, { tail: 0.1 }),
        renderSong(song, d.instruments, { tail: 0.1 })
      );
    }
  });

  it("renderInstrumentNote twice is bit identical", () => {
    const inst = fixtureInstruments().lead as NonNullable<
      ReturnType<typeof fixtureInstruments>["lead"]
    >;
    bitEqual(renderInstrumentNote(inst, 60), renderInstrumentNote(inst, 60));
  });

  it("a different seed changes the noise channel, the same seed does not", () => {
    const { song, instruments } = shortTitle();
    const a = renderSong(song, instruments, { seed: 1, tail: 0.1 });
    const b = renderSong(song, instruments, { seed: 1, tail: 0.1 });
    const c = renderSong(song, instruments, { seed: 2, tail: 0.1 });
    bitEqual(a, b);
    expect(hashChannels(c.channels)).not.toBe(hashChannels(a.channels));
  });

  it("stems do not change the mix", () => {
    const { song, instruments } = shortTitle();
    const plain = renderSong(song, instruments, { tail: 0.1 });
    const withStems = renderSong(song, instruments, { stems: true, tail: 0.1 });
    expect(hashChannels(withStems.channels)).toBe(hashChannels(plain.channels));
    // one mono stem per channel of the nes song, each as long as the mix, and every id named
    expect(withStems.stemIds).toEqual(song.channels.map((c) => c.id));
    expect(withStems.stems).toHaveLength(song.channels.length);
    for (const stem of withStems.stems ?? []) {
      expect(stem.length).toBe(withStems.frames);
    }
    expect(plain.stems).toBeUndefined();
  });
});

describe("block size independence", () => {
  function runSong(
    chip: (typeof CHIPS)[number] | "nes",
    blockSize: number,
    frames: number,
    withSfx = true
  ) {
    const synth = createSynth({ sampleRate: 48_000 });
    if (chip === "nes") {
      const { song, instruments } = fixtureSong();
      synth.loadSong(song, instruments);
      synth.loadSfx("coin", fixtureSfx());
    } else {
      const d = fixtureDemo(chip);
      synth.loadSong(d.song, d.instruments);
      synth.loadSfx("coin", d.sfx);
    }
    synth.play({ loop: true });
    // sfx triggered mid song at a fixed frame count: run in two parts so the trigger lands on the same frame
    const first = runSynth(synth, 9600, blockSize);
    if (withSfx) {
      synth.trigger("coin", { pan: 0.4, seed: 7, velocity: 0.8 });
    }
    const second = runSynth(synth, frames - 9600, blockSize);
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    left.set(first.left, 0);
    left.set(second.left, 9600);
    right.set(first.right, 0);
    right.set(second.right, 9600);
    return { left, right };
  }

  for (const chip of ["nes", ...CHIPS] as const) {
    it(`${chip}: 128 and 64 frame blocks give identical audio`, () => {
      const frames = 24_000;
      const a = runSong(chip, 128, frames);
      const b = runSong(chip, 64, frames);
      // equal silence would prove nothing
      expect(peak([a.left, a.right])).toBeGreaterThan(0.05);
      expect(hashChannels([a.left, a.right])).toBe(
        hashChannels([b.left, b.right])
      );
    });
  }

  it("the sfx trigger lands on frame 9600 whatever the block size: the audio before it is the song alone", () => {
    const frames = 24_000;
    for (const blockSize of [128, 37]) {
      const withSfx = runSong("nes", blockSize, frames);
      const songOnly = runSong("nes", blockSize, frames, false);
      const same = (from: number, to: number) =>
        hashChannels([withSfx.left.subarray(from, to)]) ===
        hashChannels([songOnly.left.subarray(from, to)]);
      expect(same(0, 9600), `before the trigger, blocks of ${blockSize}`).toBe(
        true
      );
      expect(
        same(9600, frames),
        `after the trigger, blocks of ${blockSize}`
      ).toBe(false);
    }
  });

  it("odd block sizes give identical audio too", () => {
    const a = runSong("nes", 128, 24_000);
    const b = runSong("nes", 37, 24_000);
    expect(hashChannels([a.left, a.right])).toBe(
      hashChannels([b.left, b.right])
    );
  });

  it("engine events land on the same frames for any block size", () => {
    const { song, instruments } = fixtureSong();
    const make = (block: number) => {
      const s = createSynth({ sampleRate: 48_000 });
      s.loadSong(song, instruments);
      s.play();
      return runSynth(s, 48_000, block).events;
    };
    const events = make(128);
    // the first second holds several notes and rows (150 BPM, 4 rows a beat): the comparison is of real events
    expect(events.filter((e) => e.type === "noteOn").length).toBeGreaterThan(5);
    expect(events.filter((e) => e.type === "row").length).toBeGreaterThan(5);
    expect(make(64)).toEqual(events);
    expect(make(37)).toEqual(events);
  });
});
