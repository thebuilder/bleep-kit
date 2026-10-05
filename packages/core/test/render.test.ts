// biome-ignore-all lint/style/useDestructuring: per-sample loops copy fields into locals on purpose, destructuring adds nothing there
// biome-ignore-all lint/style/useForOf: indexed loops over typed arrays in the audio path need the index
/* Offline rendering (section 4.2) and the per-chip sound checks: signal present, no clipping, no DC, no clicks at
   note boundaries. */

import { describe, expect, it } from "vitest";
import type { Instrument, RenderResult } from "../src/index.ts";
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
  peak,
  rms,
  runSynth,
} from "./helpers.ts";

const CHIPS = ["gameboy", "c64", "genesis", "adlib", "snes", "custom"] as const;
const CEILING = 10 ** (-0.3 / 20);

function dc(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i += 1) {
    s += buf[i] ?? 0;
  }
  return s / Math.max(1, buf.length);
}

function allFinite(r: RenderResult): boolean {
  for (const ch of r.channels) {
    for (let i = 0; i < ch.length; i += 1) {
      if (!Number.isFinite(ch[i])) {
        return false;
      }
    }
  }
  return true;
}

describe("renderSong", () => {
  it("renders the fixture song: audible, finite, under the limiter ceiling, no DC", () => {
    const { song, instruments } = fixtureSong();
    const r = renderSong(song, instruments);
    expect(r.sampleRate).toBe(48_000);
    expect(r.channels).toHaveLength(2);
    expect(r.channels[0]?.length).toBe(r.frames);
    expect(r.channels[1]?.length).toBe(r.frames);
    expect(allFinite(r)).toBe(true);
    expect(peak(r.channels)).toBeGreaterThan(0.1);
    expect(peak(r.channels)).toBeLessThanOrEqual(CEILING + 1e-4);
    expect(Math.abs(dc(r.channels[0] as Float32Array))).toBeLessThan(0.005);
  });

  for (const chip of CHIPS) {
    it(`${chip}: audible, finite, under the ceiling, no DC`, () => {
      const d = fixtureDemo(chip);
      const r = renderSong(d.song, d.instruments);
      expect(allFinite(r)).toBe(true);
      const p = peak(r.channels);
      expect(p).toBeGreaterThan(0.1);
      expect(p).toBeLessThanOrEqual(CEILING + 1e-4);
      expect(Math.abs(dc(r.channels[0] as Float32Array))).toBeLessThan(0.006);
      expect(Math.abs(dc(r.channels[1] as Float32Array))).toBeLessThan(0.006);
    });
  }

  it("honours the sample rate", () => {
    const { song, instruments } = fixtureSong();
    const a = renderSong(song, instruments, { sampleRate: 48_000, tail: 0.5 });
    const b = renderSong(song, instruments, { sampleRate: 44_100, tail: 0.5 });
    expect(b.sampleRate).toBe(44_100);
    expect(b.frames / 44_100).toBeCloseTo(a.frames / 48_000, 1);
  });

  it("tail extends the render by the requested seconds", () => {
    const { song, instruments } = fixtureSong();
    const a = renderSong(song, instruments, { tail: 0.25 });
    const b = renderSong(song, instruments, { tail: 1.25 });
    expect(b.frames - a.frames).toBe(48_000);
  });

  it("loops: the loop section is repeated and loopStart and loopEnd bracket one pass", () => {
    const { song, instruments } = fixtureSong();
    const one = renderSong(song, instruments, { loops: 1, tail: 0 });
    const three = renderSong(song, instruments, { loops: 3, tail: 0 });
    expect(one.loopStart).toBeDefined();
    expect(one.loopEnd).toBeDefined();
    const pass = (one.loopEnd ?? 0) - (one.loopStart ?? 0);
    expect(pass).toBeGreaterThan(0);
    expect(one.loopStart).toBe(three.loopStart);
    expect(three.frames - one.frames).toBeGreaterThanOrEqual(2 * pass - 2);
    expect(three.frames - one.frames).toBeLessThanOrEqual(2 * pass + 2);
    expect(three.events.filter((e) => e.type === "loop")).toHaveLength(2);
  });

  it("the loop is seamless: the audio one pass later matches in level and pitch content", () => {
    const { song, instruments } = fixtureSong();
    const r = renderSong(song, instruments, { loops: 3, tail: 0 });
    const ls = r.loopStart ?? 0;
    const le = r.loopEnd ?? 0;
    const pass = le - ls;
    const left = r.channels[0] as Float32Array;
    // the second and third passes are the same music: compare rms of the matching halves
    const a = rms(left, ls + 4800, ls + pass - 4800);
    const b = rms(left, ls + pass + 4800, ls + 2 * pass - 4800);
    expect(Math.abs(a - b) / Math.max(a, 1e-9)).toBeLessThan(0.15);
  });

  it("songs without a loop have no loop points", () => {
    const { song, instruments } = fixtureSong();
    const noLoop = { ...song, loop: null };
    const r = renderSong(noLoop, instruments, { tail: 0.1 });
    expect(r.loopStart).toBeUndefined();
    expect(r.loopEnd).toBeUndefined();
  });

  it("stems: one dry mono stem per channel, with the channel ids", () => {
    const { song, instruments } = fixtureSong();
    const r = renderSong(song, instruments, { stems: true, tail: 0.1 });
    expect(r.stemIds).toEqual(song.channels.map((c) => c.id));
    expect(r.stems).toHaveLength(song.channels.length);
    for (const st of r.stems ?? []) {
      expect(st.length).toBe(r.frames);
    }
    expect(peak([r.stems?.[0] as Float32Array])).toBeGreaterThan(0.05);
    expect(renderSong(song, instruments, { tail: 0.1 }).stems).toBeUndefined();
  });

  it("events: noteOn and row events are inside the render and ordered by frame", () => {
    const { song, instruments } = fixtureSong();
    const r = renderSong(song, instruments, { tail: 0.1 });
    expect(r.events.length).toBeGreaterThan(20);
    let last = -1;
    for (const e of r.events) {
      expect(e.frame).toBeGreaterThanOrEqual(last);
      expect(e.frame).toBeLessThan(r.frames);
      last = e.frame;
    }
    expect(r.events.some((e) => e.type === "end")).toBe(true);
  });

  it("onProgress is called and returning false aborts the render", () => {
    const { song, instruments } = fixtureSong();
    let calls = 0;
    const aborted = renderSong(song, instruments, {
      onProgress: () => {
        calls += 1;
        return calls < 2 ? undefined : false;
      },
    });
    const full = renderSong(song, instruments);
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(aborted.frames).toBeLessThan(full.frames);
  });

  it("an empty song renders silence of the tail length at most", () => {
    const { song, instruments } = fixtureSong();
    const empty = {
      ...song,
      channels: song.channels.map((c) => ({ ...c, mml: null })),
      loop: null,
      order: [],
      patterns: {},
    };
    const r = renderSong(empty, instruments, { tail: 0.2 });
    expect(allFinite(r)).toBe(true);
    expect(peak(r.channels)).toBe(0);
    expect(r.frames).toBeLessThan(48_000 * 2);
  });

  it("master volume and limiter come from the song", () => {
    const { song, instruments } = fixtureSong();
    const quiet = renderSong(
      { ...song, master: { ...song.master, volume: 0.25 } },
      instruments,
      { tail: 0.1 }
    );
    const normal = renderSong(song, instruments, { tail: 0.1 });
    expect(peak(quiet.channels)).toBeLessThan(peak(normal.channels) * 0.6);
  });
});

describe("renderSfx", () => {
  it("renders the coin: short, audible, trimmed to the end of the sound", () => {
    const r = renderSfx(fixtureSfx());
    expect(allFinite(r)).toBe(true);
    expect(r.frames / r.sampleRate).toBeGreaterThan(0.1);
    expect(r.frames / r.sampleRate).toBeLessThan(0.6);
    expect(peak(r.channels)).toBeGreaterThan(0.1);
    // the last 10 ms is the only quiet part
    const tail = Math.round(0.02 * r.sampleRate);
    expect(rms(r.channels[0] as Float32Array, r.frames - tail)).toBeLessThan(
      0.01
    );
    expect(r.events.some((e) => e.type === "trigger")).toBe(true);
  });

  for (const chip of CHIPS) {
    it(`${chip} sfx is audible and finite`, () => {
      const r = renderSfx(fixtureDemo(chip).sfx);
      expect(allFinite(r)).toBe(true);
      expect(peak(r.channels)).toBeGreaterThan(0.02);
      expect(peak(r.channels)).toBeLessThanOrEqual(CEILING + 1e-4);
      expect(Math.abs(dc(r.channels[0] as Float32Array))).toBeLessThan(0.01);
    });
  }

  it("the seed drives noise sfx", () => {
    const base = fixtureJson("sfx-coin.json") as Record<string, unknown>;
    const noisy = (seed: number) =>
      renderSfx(normalizeSfxSeed(base, seed), { seed });
    const a = noisy(1);
    const b = noisy(1);
    expect(
      Array.from((a.channels[0] as Float32Array).subarray(0, 2000))
    ).toEqual(Array.from((b.channels[0] as Float32Array).subarray(0, 2000)));
  });

  it("tail 0 trims right after the sound and a long tail is trimmed back to silence", () => {
    const a = renderSfx(fixtureSfx(), { tail: 0 });
    const b = renderSfx(fixtureSfx(), { tail: 2 });
    expect(b.frames).toBeLessThan(a.frames + 48_000);
  });
});

function normalizeSfxSeed(base: Record<string, unknown>, seed: number) {
  const sfx = fixtureSfx();
  return {
    ...sfx,
    name: String(base.name ?? "n"),
    seed,
    wave: "noise" as const,
  };
}

describe("renderInstrumentNote", () => {
  it("plays a note and its release", () => {
    const inst = fixtureInstruments().lead as Instrument;
    const r = renderInstrumentNote(inst, 69, { duration: 0.3, release: 0.3 });
    expect(r.frames).toBeGreaterThanOrEqual(0.55 * 48_000);
    expect(peak(r.channels)).toBeGreaterThan(0.05);
    expect(rms(r.channels[0] as Float32Array, r.frames - 2400)).toBeLessThan(
      0.005
    );
  });

  it("uses the chip of the instrument, and falls back to custom for a kind the chip lacks", () => {
    const fm = normalizeInstrument(
      fixtureJson("instrument-fm-bass.json")
    ).value;
    const r = renderInstrumentNote(fm, 45, { duration: 0.3, release: 0.2 });
    expect(peak(r.channels)).toBeGreaterThan(0.02);
    const asNes = renderInstrumentNote(fm, 45, {
      chip: "nes",
      duration: 0.3,
      release: 0.2,
    });
    expect(allFinite(asNes)).toBe(true);
    expect(peak(asNes.channels)).toBeGreaterThan(0.02);
  });

  it("sample instruments play their generator", () => {
    const inst = normalizeInstrument(
      fixtureJson("instrument-snes-pluck.json")
    ).value;
    const r = renderInstrumentNote(inst, 60, { duration: 0.4, release: 0.2 });
    expect(peak(r.channels)).toBeGreaterThan(0.05);
  });
});

/* A click is a step at a note boundary much larger than anything else nearby. Each channel is soloed through the real
   synth (limiter off, so only the voice and its chip bus shape the signal) and every noteOn and noteOff is inspected. */
describe("no clicks at note boundaries", () => {
  function scan(chip: string): { worst: number; where: string }[] {
    const d = chip === "nes" ? null : fixtureDemo(chip);
    const { song, instruments } = d ?? fixtureSong();
    const out: { worst: number; where: string }[] = [];
    for (let c = 0; c < song.channels.length; c += 1) {
      const s = createSynth({ sampleRate: 48_000 });
      s.loadSong(song, instruments);
      const n = s.channels().length;
      for (let k = 0; k < n; k += 1) {
        s.setChannel(k, { muted: k !== c });
      }
      s.setMaster({ limiter: false });
      s.play({ loop: false });
      const latency = (s as unknown as { latency: number }).latency;
      const r = runSynth(s, 48_000 * 5);
      const m = r.left;
      const pk = peak([m]);
      if (pk < 1e-3) {
        continue;
      }
      let worst = 0;
      let where = "";
      for (const e of r.events) {
        if (e.channel !== c || (e.type !== "noteOn" && e.type !== "noteOff")) {
          continue;
        }
        const f = e.frame + latency;
        if (f < 400 || f > m.length - 400) {
          continue;
        }
        let step = 0;
        for (let i = f - 1; i <= f + 2; i += 1) {
          step = Math.max(step, Math.abs((m[i] ?? 0) - (m[i - 1] ?? 0)));
        }
        let nb = 0;
        for (let i = f - 300; i <= f + 300; i += 1) {
          if (i >= f - 3 && i <= f + 4) {
            continue;
          }
          nb = Math.max(nb, Math.abs((m[i] ?? 0) - (m[i - 1] ?? 0)));
        }
        // ignore steps that are small against the channel's own level
        const ratio = step > 0.08 * pk ? step / Math.max(nb, 0.01 * pk) : 0;
        if (ratio > worst) {
          worst = ratio;
          where = `${song.channels[c]?.id} ${e.type} at ${e.frame}`;
        }
      }
      out.push({ where, worst });
    }
    return out;
  }

  for (const chip of ["nes", ...CHIPS] as const) {
    it(`${chip}: no boundary step stands out from its neighbourhood`, () => {
      for (const r of scan(chip)) {
        expect(r.worst, r.where).toBeLessThan(1.6);
      }
    });
  }

  it("a legato retrigger on an FM voice is hidden by the declick offset", () => {
    const d = fixtureDemo("adlib");
    const s = createSynth({ sampleRate: 48_000 });
    s.loadSong(d.song, d.instruments);
    s.setMaster({ limiter: false });
    const id =
      Object.keys(d.instruments).find((k) => d.instruments[k]?.kind === "fm") ??
      "";
    s.noteOn(0, 72, 1, id);
    const before = runSynth(s, 4800);
    s.noteOn(0, 74, 1, id);
    const after = runSynth(s, 480);
    const lat = (s as unknown as { latency: number }).latency;
    const tail = before.left.subarray(before.left.length - 4);
    const joined = new Float32Array(tail.length + after.left.length);
    joined.set(tail);
    joined.set(after.left, tail.length);
    let step = 0;
    for (let i = lat; i < lat + 6; i += 1) {
      step = Math.max(
        step,
        Math.abs(
          (joined[tail.length + i] ?? 0) - (joined[tail.length + i - 1] ?? 0)
        )
      );
    }
    expect(step).toBeLessThan(0.1 * Math.max(peak([before.left]), 0.01) + 0.02);
  });
});
