/* Golden hashes, determinism and block-size independence (architecture section 9). Run with UPDATE_GOLDEN=1 to rewrite
   test/golden/<id>.json after an intentional change to the sound. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RenderResult } from "../src/index.ts";
import {
  createSynth,
  normalizeInstrument,
  renderInstrumentNote,
  renderSfx,
  renderSong,
} from "../src/index.ts";
import {
  fixtureDemo,
  fixtureInstruments,
  fixtureJson,
  fixtureSfx,
  fixtureSong,
  hashChannels,
  runSynth,
} from "./helpers.ts";

const GOLDEN = fileURLToPath(new URL("./golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const RATES = [48_000, 44_100] as const;
const CHIPS = ["gameboy", "c64", "genesis", "adlib", "snes", "custom"] as const;

interface Entry {
  events: number;
  frames: number;
  hash: string;
}
type GoldenFile = Record<string, Entry>;

function summarize(r: RenderResult): Entry {
  return {
    events: r.events.length,
    frames: r.frames,
    hash: hashChannels(r.channels),
  };
}

function checkGolden(id: string, make: (rate: number) => RenderResult): void {
  const path = `${GOLDEN}${id}.json`;
  const now: GoldenFile = {};
  for (const rate of RATES) {
    now[String(rate)] = summarize(make(rate));
  }
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(path, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  expect(
    existsSync(path),
    `missing golden ${id}.json, run with UPDATE_GOLDEN=1`
  ).toBe(true);
  const want = JSON.parse(readFileSync(path, "utf8")) as GoldenFile;
  expect(now).toEqual(want);
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

  const instrumentFiles = [
    "instrument-lead",
    "instrument-bass",
    "instrument-drums",
    "instrument-fm-bass",
    "instrument-snes-pluck",
  ];
  for (const file of instrumentFiles) {
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
  it("renderSong twice is bit identical", () => {
    const { song, instruments } = fixtureSong();
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
      bitEqual(
        renderSong(d.song, d.instruments, { tail: 0.1 }),
        renderSong(d.song, d.instruments, { tail: 0.1 })
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
    const { song, instruments } = fixtureSong();
    const a = renderSong(song, instruments, { seed: 1, tail: 0.1 });
    const b = renderSong(song, instruments, { seed: 1, tail: 0.1 });
    const c = renderSong(song, instruments, { seed: 2, tail: 0.1 });
    bitEqual(a, b);
    expect(hashChannels(c.channels)).not.toBe(hashChannels(a.channels));
  });

  it("stems do not change the mix", () => {
    const { song, instruments } = fixtureSong();
    const plain = renderSong(song, instruments, { tail: 0.1 });
    const withStems = renderSong(song, instruments, { stems: true, tail: 0.1 });
    expect(hashChannels(withStems.channels)).toBe(hashChannels(plain.channels));
    expect(withStems.stems?.length).toBe(withStems.stemIds?.length);
  });
});

describe("block size independence", () => {
  function runSong(
    chip: (typeof CHIPS)[number] | "nes",
    blockSize: number,
    frames: number
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
    synth.trigger("coin", { pan: 0.4, seed: 7, velocity: 0.8 });
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
      const frames = 48_000;
      const a = runSong(chip, 128, frames);
      const b = runSong(chip, 64, frames);
      expect(hashChannels([a.left, a.right])).toBe(
        hashChannels([b.left, b.right])
      );
    });
  }

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
    expect(make(64)).toEqual(make(128));
  });
});
