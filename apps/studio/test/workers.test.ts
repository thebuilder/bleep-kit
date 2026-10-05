/* The two workers' logic called directly (happy-dom has a document, so the message handlers are not installed):
   answering render requests with the right buffers to transfer, and encoding with the fall back to WAV. */
import { describe, expect, it, vi } from "vitest";
import type { RenderRequest, RenderResponse } from "../src/workers/render.ts";
import { respond } from "../src/workers/render.ts";

/* The wasm encoders cannot start under happy-dom (its Response is not Node's), and the core package tests them for real,
   so here they are stand-ins that either work or throw. */
const encoders = { fail: false };
const STAND_IN = new Uint8Array([79, 103, 103, 83]);
vi.mock("../src/lib/core.ts", async (original) => {
  const core = await original<typeof import("../src/lib/core.ts")>();
  const stand = (what: string) => () =>
    encoders.fail
      ? Promise.reject(new Error(`no ${what}`))
      : Promise.resolve(STAND_IN);
  return { ...core, encodeMp3: stand("mp3"), encodeOgg: stand("ogg") };
});

const { runEncode } = await import("../src/workers/encode.ts");
const { starterFiles } = await import("../src/store/seed.ts");

const sfxDocs = [...starterFiles()].filter(([p]) => p.startsWith("sfx/"));
const sfx = sfxDocs[0]?.[1] as never;
const song = [...starterFiles()].find(([p]) =>
  p.startsWith("songs/")
)?.[1] as never;
const instruments = Object.fromEntries(
  [...starterFiles()]
    .filter(([p]) => p.startsWith("instruments/"))
    .map(([p, v]) => [p.replace(/^.*\/|\.json$/g, ""), v])
) as never;
const master = { limiter: true, volume: 0.8 };

function run(req: RenderRequest) {
  const posted: {
    message: RenderResponse;
    transfer?: Transferable[] | undefined;
  }[] = [];
  respond(req, (message, transfer) => posted.push({ message, transfer }));
  return posted[0] as (typeof posted)[number];
}

describe("the render worker", () => {
  it("answers an sfx request with its samples, handed over", () => {
    const { message, transfer } = run({
      id: 7,
      kind: "sfx",
      master,
      rate: 22_050,
      sfx,
    });
    expect(message).toMatchObject({ id: 7 });
    expect("result" in message && message.result.frames).toBeGreaterThan(100);
    expect(transfer?.length).toBeGreaterThan(0);
  });

  it("answers a song request with its stems as well", () => {
    const { message, transfer } = run({
      id: 8,
      instruments,
      kind: "song",
      master,
      rate: 8000,
      song,
      stems: true,
    });
    expect("result" in message && message.result.stems?.length).toBeGreaterThan(
      0
    );
    expect(transfer?.length).toBeGreaterThan(2);
  });

  it("answers an analysis request with the analysis and its images", () => {
    const { message, transfer } = run({
      file: "coin.json",
      id: 9,
      kind: "analysis",
      master,
      rate: 22_050,
      source: { sfx, type: "sfx" },
      width: 200,
    });
    expect("bundle" in message && message.bundle.analysis).toBeTruthy();
    expect(transfer?.length).toBeGreaterThan(0);
  });

  it("analyses a song and a single instrument note too", () => {
    const a = run({
      file: "s",
      id: 1,
      kind: "analysis",
      master,
      rate: 8000,
      source: { instruments, song, type: "song" },
      width: 100,
    });
    expect("bundle" in a.message).toBe(true);
    const [name, inst] = Object.entries(
      instruments as Record<string, unknown>
    )[0] as [string, never];
    const b = run({
      file: name,
      id: 2,
      kind: "analysis",
      master,
      rate: 22_050,
      source: { inst, note: 60, type: "note" },
      width: 100,
    });
    expect("bundle" in b.message).toBe(true);
  });

  it("answers a request it cannot render with an error carrying its id", () => {
    const { message } = run({
      id: 3,
      kind: "sfx",
      master,
      rate: 22_050,
      sfx: null as never,
    });
    expect(message).toMatchObject({ id: 3 });
    expect("error" in message && message.error.length).toBeGreaterThan(0);
  });
});

describe("the encode worker", () => {
  const req = (format: "wav" | "ogg" | "mp3", loop = false) => ({
    bitrate: 128,
    channels: [new Float32Array(4800).map((_, i) => Math.sin(i / 8) * 0.5)],
    format,
    frames: 4800,
    id: 1,
    loopEnd: loop ? 4000 : null,
    loopStart: loop ? 800 : null,
    name: "test",
    quality: 0.4,
    sampleRate: 48_000,
  });

  it("writes a WAV", async () => {
    const out = await runEncode(req("wav", true));
    expect(out.used).toBe("wav");
    expect(new TextDecoder().decode(out.bytes.slice(0, 4))).toBe("RIFF");
  });

  it("writes OGG and MP3 when the encoders work", async () => {
    expect(await runEncode(req("ogg"))).toEqual({
      bytes: STAND_IN,
      used: "ogg",
    });
    expect(await runEncode(req("mp3"))).toEqual({
      bytes: STAND_IN,
      used: "mp3",
    });
  });

  it("falls back to WAV and says why when an encoder fails", async () => {
    encoders.fail = true;
    const ogg = await runEncode(req("ogg"));
    expect(ogg).toMatchObject({
      note: "OGG encoding failed (no ogg), wrote WAV",
      used: "wav",
    });
    const mp3 = await runEncode(req("mp3"));
    expect(mp3).toMatchObject({
      note: "MP3 encoding failed (no mp3), wrote WAV",
      used: "wav",
    });
    encoders.fail = false;
  });
});
