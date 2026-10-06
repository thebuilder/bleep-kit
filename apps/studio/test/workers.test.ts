/* The two workers' logic called directly (happy-dom has a document, so the message handlers are not installed):
   answering render requests with samples that are the right sound, scaled by the master, with buffers that can really
   be transferred, and encoding with the right encoder and its options, the fall back to WAV, and the samples and loop
   points that end up in the file. */
import { decodeWav } from "@bleepkit/core/tools";
import { describe, expect, it, vi } from "vitest";
import type { Instrument, Sfx, Song } from "../src/lib/contract.ts";
import type { RenderRequest, RenderResponse } from "../src/workers/render.ts";
import { respond } from "../src/workers/render.ts";

/* The wasm encoders cannot start under happy-dom (its Response is not Node's), and the core package tests them for real,
   so here they are stand-ins. A working one answers with a line naming the format, the option it was given and the
   render it was handed, so the test can see the worker called the right encoder with the right things; a broken one
   throws. */
const encoders = { fail: false };
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
vi.mock("../src/lib/core.ts", async (original) => {
  const core = await original<typeof import("../src/lib/core.ts")>();
  const stand =
    (what: string, option: "bitrate" | "quality") =>
    (
      r: { frames: number; loopEnd?: number; loopStart?: number },
      opts: Record<string, number>
    ) =>
      encoders.fail
        ? Promise.reject(new Error(`no ${what}`))
        : Promise.resolve(
            new TextEncoder().encode(
              `${what} ${option}=${opts[option]} frames=${r.frames} loop=${r.loopStart ?? "none"}-${r.loopEnd ?? "none"}`
            )
          );
  return {
    ...core,
    encodeMp3: stand("mp3", "bitrate"),
    encodeOgg: stand("ogg", "quality"),
  };
});

const { runEncode } = await import("../src/workers/encode.ts");
const { starterFiles } = await import("../src/store/seed.ts");

const starter = [...starterFiles()];
const sfx = starter.find(([p]) => p.startsWith("sfx/"))?.[1] as Sfx;
const song = starter.find(([p]) => p.startsWith("songs/"))?.[1] as Song;
const instruments = Object.fromEntries(
  starter
    .filter(([p]) => p.startsWith("instruments/"))
    .map(([p, v]) => [p.replace(/^.*\/|\.json$/g, ""), v as Instrument])
);
const noLimit = { limiter: false, volume: 0.8 };

const peak = (samples: Float32Array) =>
  samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** What the worker posted for a request: exactly one message, and what it handed over. */
function run(req: RenderRequest) {
  const posted: {
    message: RenderResponse;
    transfer?: Transferable[] | undefined;
  }[] = [];
  respond(req, (message, transfer) => posted.push({ message, transfer }));
  expect(posted).toHaveLength(1);
  return posted[0] as (typeof posted)[number];
}

/** A render answer, with the transfer list, failing the test if the worker answered something else. */
function render(req: RenderRequest) {
  const { message, transfer } = run(req);
  if (!("result" in message)) {
    throw new Error(
      `expected a render result, got ${JSON.stringify(message).slice(0, 80)}`
    );
  }
  return { message, result: message.result, transfer: transfer ?? [] };
}

/** An analysis answer, likewise. */
function analyse(req: RenderRequest) {
  const { message, transfer } = run(req);
  if (!("bundle" in message)) {
    throw new Error(
      `expected an analysis, got ${JSON.stringify(message).slice(0, 80)}`
    );
  }
  return { bundle: message.bundle, transfer: transfer ?? [] };
}

/** A transfer list that postMessage would accept: no buffer named twice (that throws a DataCloneError). */
const transferable = (list: Transferable[]) =>
  new Set(list).size === list.length;

describe("the render worker", () => {
  it("answers an sfx request with that sound's samples, tagged with the request's id", () => {
    const { message, result } = render({
      id: 7,
      kind: "sfx",
      master: noLimit,
      rate: 22_050,
      sfx,
    });
    expect(message.id).toBe(7);
    expect(result.sampleRate).toBe(22_050);
    expect(result.channels.length).toBeGreaterThan(0);
    for (const channel of result.channels) {
      expect(channel).toHaveLength(result.frames);
    }
    // a sound with a body, not silence, and inside the range a sample can have
    const top = peak(result.channels[0] as Float32Array);
    expect(top).toBeGreaterThan(0.05);
    expect(top).toBeLessThanOrEqual(1);
  });

  it("hands over exactly the sample buffers it answered with, none twice", () => {
    const { result, transfer } = render({
      id: 1,
      kind: "sfx",
      master: noLimit,
      rate: 22_050,
      sfx,
    });
    expect(transferable(transfer)).toBe(true);
    expect(new Set(transfer)).toEqual(
      new Set(result.channels.map((c) => c.buffer))
    );
  });

  it("applies the master volume: half the volume is half the amplitude", () => {
    const at = (volume: number) =>
      peak(
        render({
          id: 1,
          kind: "sfx",
          master: { limiter: false, volume },
          rate: 22_050,
          sfx,
        }).result.channels[0] as Float32Array
      );
    expect(at(0.4) / at(0.8)).toBeCloseTo(0.5, 2);
  });

  it("answers a song request with one stem per channel when asked, and none when not", () => {
    const base = {
      id: 8,
      instruments,
      kind: "song",
      master: noLimit,
      rate: 8000,
      song,
    } as const;
    const withStems = render({ ...base, stems: true });
    const stems = withStems.result.stems ?? [];
    expect(stems).toHaveLength(song.channels.length);
    for (const stem of stems) {
      expect(stem).toHaveLength(withStems.result.frames);
    }
    expect(transferable(withStems.transfer)).toBe(true);
    expect(new Set(withStems.transfer)).toEqual(
      new Set([...withStems.result.channels, ...stems].map((c) => c.buffer))
    );

    const without = render({ ...base, stems: false });
    expect(without.result.stems).toBeUndefined();
    expect(new Set(without.transfer)).toEqual(
      new Set(without.result.channels.map((c) => c.buffer))
    );
  });

  it("answers an sfx analysis with measurements of that render, the images drawn at the asked width, and their pixels handed over", () => {
    const req = {
      file: "coin.json",
      id: 9,
      kind: "analysis",
      master: noLimit,
      rate: 22_050,
      source: { sfx, type: "sfx" },
      width: 640,
    } as const;
    const { bundle, transfer } = analyse(req);
    const rendered = render({
      id: 1,
      kind: "sfx",
      master: noLimit,
      rate: 22_050,
      sfx,
    }).result;
    expect(bundle.analysis.sampleRate).toBe(22_050);
    expect(bundle.analysis.frames).toBe(rendered.frames);
    expect(bundle.analysis.peakDb).toBeCloseTo(
      20 * Math.log10(peak(rendered.channels[0] as Float32Array)),
      1
    );
    const { scopes, spectrogram, waveform } = bundle.images;
    expect(waveform?.width).toBe(640);
    expect(spectrogram?.width).toBe(640);
    // the scopes are for songs: a single sound has none
    expect(scopes).toBeNull();
    expect(bundle.result).toBeNull();
    expect(transferable(transfer)).toBe(true);
    expect(new Set(transfer)).toEqual(
      new Set([waveform?.data.buffer, spectrogram?.data.buffer])
    );
  });

  it("analyses a song with its scopes and its loop", () => {
    const { bundle } = analyse({
      file: "starter-theme.json",
      id: 1,
      kind: "analysis",
      master: noLimit,
      rate: 8000,
      source: { instruments, song, type: "song" },
      width: 480,
    });
    expect(bundle.images.scopes?.width).toBe(480);
    expect(bundle.analysis.loop).not.toBeNull();
    expect(bundle.analysis.duration).toBeGreaterThan(5);
  });

  it("analyses an instrument on the note it was asked for", () => {
    const [name, inst] = Object.entries(instruments).find(
      ([, i]) => i.kind === "pulse"
    ) as [string, Instrument];
    const pitch = (note: number) =>
      analyse({
        file: name,
        id: 2,
        kind: "analysis",
        master: noLimit,
        rate: 22_050,
        source: { inst, note, type: "note" },
        width: 100,
      }).bundle.analysis.pitch.medianHz as number;
    // the instrument's own transpose and tuning move it, so allow a semitone
    expect(pitch(69)).toBeGreaterThan(440 / 2 ** (1 / 12));
    expect(pitch(69)).toBeLessThan(440 * 2 ** (1 / 12));
    expect(pitch(81) / pitch(69)).toBeCloseTo(2, 1);
  });

  it("answers a request it cannot render with an error carrying its id, and hands nothing over", () => {
    const { message, transfer } = run({
      id: 3,
      kind: "sfx",
      master: noLimit,
      rate: 22_050,
      sfx: null as never,
    });
    expect(message).toEqual({ error: expect.any(String), id: 3 });
    expect("error" in message && message.error.length).toBeGreaterThan(0);
    expect(transfer).toBeUndefined();
  });
});

describe("the encode worker", () => {
  const wave = (n: number, f: (i: number) => number) =>
    new Float32Array(n).map((_, i) => f(i));
  const left = wave(4800, (i) => Math.sin(i / 8) * 0.5);
  const right = wave(4800, (i) => -Math.sin(i / 8) * 0.25);
  const req = (
    format: "wav" | "ogg" | "mp3",
    over: Partial<Parameters<typeof runEncode>[0]> = {}
  ) => ({
    bitrate: 128,
    channels: [left],
    format,
    frames: 4800,
    id: 1,
    loopEnd: null,
    loopStart: null,
    name: "test",
    quality: 0.4,
    sampleRate: 48_000,
    ...over,
  });
  /** The largest difference between decoded samples and what was put in. */
  const worst = (got: Float32Array, want: Float32Array) =>
    got.reduce((m, v, i) => Math.max(m, Math.abs(v - (want[i] as number))), 0);

  it("writes a WAV that decodes to the samples it was given", async () => {
    const out = await runEncode(req("wav"));
    expect(out.used).toBe("wav");
    expect(out.note).toBeUndefined();
    const back = decodeWav(out.bytes);
    expect(back.sampleRate).toBe(48_000);
    expect(back.frames).toBe(4800);
    expect(back.channels).toHaveLength(1);
    // 16 bit samples: within a step of what went in
    expect(worst(back.channels[0] as Float32Array, left)).toBeLessThan(
      1 / 16_000
    );
    expect(back.loopStart).toBeUndefined();
  });

  it("keeps stereo channels apart and in order", async () => {
    const back = decodeWav(
      (await runEncode(req("wav", { channels: [left, right] }))).bytes
    );
    expect(back.channels).toHaveLength(2);
    expect(worst(back.channels[0] as Float32Array, left)).toBeLessThan(
      1 / 16_000
    );
    expect(worst(back.channels[1] as Float32Array, right)).toBeLessThan(
      1 / 16_000
    );
  });

  it("writes the loop points into the WAV", async () => {
    const back = decodeWav(
      (await runEncode(req("wav", { loopEnd: 4000, loopStart: 800 }))).bytes
    );
    expect([back.loopStart, back.loopEnd]).toEqual([800, 4000]);
    // a loop with only one end given is not a loop
    const half = decodeWav(
      (await runEncode(req("wav", { loopEnd: null, loopStart: 800 }))).bytes
    );
    expect(half.loopStart).toBeUndefined();
  });

  it("hands OGG to the OGG encoder with the quality and MP3 to the MP3 encoder with the bitrate, with the render and its loop", async () => {
    const loop = { loopEnd: 4000, loopStart: 800 };
    const ogg = await runEncode(req("ogg", loop));
    expect(ogg.used).toBe("ogg");
    expect(ogg.note).toBeUndefined();
    expect(text(ogg.bytes)).toBe("ogg quality=0.4 frames=4800 loop=800-4000");
    const mp3 = await runEncode(req("mp3"));
    expect(mp3.used).toBe("mp3");
    expect(text(mp3.bytes)).toBe("mp3 bitrate=128 frames=4800 loop=none-none");
  });

  it("falls back to a real WAV and says why when an encoder fails", async () => {
    encoders.fail = true;
    try {
      for (const [format, name] of [
        ["ogg", "OGG"],
        ["mp3", "MP3"],
      ] as const) {
        // biome-ignore lint/performance/noAwaitInLoops: the two formats are tried one after the other
        const out = await runEncode(
          req(format, { loopEnd: 4000, loopStart: 800 })
        );
        expect(out.used).toBe("wav");
        expect(out.note).toBe(
          `${name} encoding failed (no ${format}), wrote WAV`
        );
        const back = decodeWav(out.bytes);
        expect(worst(back.channels[0] as Float32Array, left)).toBeLessThan(
          1 / 16_000
        );
        expect([back.loopStart, back.loopEnd]).toEqual([800, 4000]);
      }
    } finally {
      encoders.fail = false;
    }
  });
});
