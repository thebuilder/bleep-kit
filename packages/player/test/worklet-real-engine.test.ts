// @vitest-environment node
/* The shipped worklet bundle against the real engine: build it, evaluate it in a worklet-like scope, instantiate the
   registered processor, send documents and render audio. Fails loudly when @bleepkit/core cannot synthesize. */

import {
  type EngineEvent,
  type FromWorklet,
  normalizeInstrument,
  normalizeSfx,
  normalizeSong,
} from "@bleepkit/core";
import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import bassJson from "../../core/test/fixtures/instrument-bass.json" with {
  type: "json",
};
import drumsJson from "../../core/test/fixtures/instrument-drums.json" with {
  type: "json",
};
import leadJson from "../../core/test/fixtures/instrument-lead.json" with {
  type: "json",
};
import coinJson from "../../core/test/fixtures/sfx-coin.json" with {
  type: "json",
};
import songJson from "../../core/test/fixtures/song-title.json" with {
  type: "json",
};
import { workletBuildOptions } from "../worklet-build-options.ts";

const ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname
).replace(/\/$/, "");
const EXPORT_LIST = /^export\s*\{[^}]*\};?\s*$/m;
const RATE = 48_000;

interface Processor {
  process: (
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    p: Record<string, Float32Array>
  ) => boolean;
}

async function load() {
  const { outfile: _outfile, ...options } = workletBuildOptions(ROOT);
  const result = await build({ ...options, write: false });
  const code = result.outputFiles?.[0]?.text ?? "";
  const posted: { message: FromWorklet; transfer: unknown }[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (message: FromWorklet, transfer?: unknown) =>
      posted.push({ message, transfer }),
  };
  class Base {
    port = port;
  }
  let Ctor: (new (o?: unknown) => Processor) | undefined;
  const clock = { time: 0 };
  vi.stubGlobal("AudioWorkletProcessor", Base);
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, c: new (o?: unknown) => Processor) => {
      Ctor = c;
    }
  );
  vi.stubGlobal("sampleRate", RATE);
  vi.stubGlobal("currentTime", 0);
  new Function(code.replace(EXPORT_LIST, ""))();
  if (!Ctor) {
    throw new Error("the bundle did not register a processor");
  }
  const processor = new Ctor({ processorOptions: { scopeFrames: 2048 } });
  const left = new Float32Array(128);
  const right = new Float32Array(128);
  /** Render blocks and report the largest sample seen in each channel. */
  const render = (blocks: number) => {
    const peak = { left: 0, right: 0 };
    for (let i = 0; i < blocks; i += 1) {
      vi.stubGlobal("currentTime", clock.time);
      processor.process([], [[left, right]], {});
      clock.time += 128 / RATE;
      for (let k = 0; k < left.length; k += 1) {
        peak.left = Math.max(peak.left, Math.abs(left[k] ?? 0));
        peak.right = Math.max(peak.right, Math.abs(right[k] ?? 0));
      }
    }
    return peak;
  };
  const send = (data: unknown) => port.onmessage?.({ data });
  const of = <T extends FromWorklet["type"]>(type: T) =>
    posted
      .map((p) => p.message)
      .filter((m): m is Extract<FromWorklet, { type: T }> => m.type === type);
  return { of, posted, render, send };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const sfx = normalizeSfx(coinJson).value;
const instruments = {
  bass: normalizeInstrument(bassJson).value,
  drums: normalizeInstrument(drumsJson).value,
  lead: normalizeInstrument(leadJson).value,
};
const song = normalizeSong(songJson, instruments).value;

describe("the worklet bundle with the real engine", () => {
  it("announces ready, plays a triggered sfx and releases its handle", async () => {
    const w = await load();
    expect(w.of("ready")).toEqual([{ sampleRate: RATE, type: "ready" }]);
    expect(w.render(4)).toEqual({ left: 0, right: 0 });
    w.send({ id: "coin", sfx, type: "loadSfx" });
    w.send({ handle: 1, id: "coin", type: "trigger", velocity: 1 });
    const sounding = w.render(40);
    expect(sounding.left).toBeGreaterThan(0.01);
    expect(sounding.right).toBeGreaterThan(0.01);
    w.send({ handle: 1, type: "release" });
    w.render(200);
    expect(w.of("error")).toEqual([]);
    // a sound effect ends: nothing keeps ringing after it
    expect(w.render(50)).toEqual({ left: 0, right: 0 });
    const triggers = w
      .of("events")
      .flatMap((m) => m.events)
      .filter((e: EngineEvent) => e.type === "trigger");
    expect(triggers.map((e) => e.id)).toEqual(["coin"]);
  });

  it("plays a song, posts events, clock with position and scope copies", async () => {
    const w = await load();
    w.send({ instruments, song, type: "loadSong" });
    w.send({ loop: true, type: "play" });
    const sounding = w.render(120);
    expect(sounding.left).toBeGreaterThan(0.01);
    expect(sounding.right).toBeGreaterThan(0.01);
    expect(w.of("error")).toEqual([]);
    const events = w.of("events").flatMap((m) => m.events);
    expect(events.some((e) => e.type === "noteOn")).toBe(true);
    expect(events.some((e) => e.type === "row")).toBe(true);
    const clocks = w.of("clock");
    expect(clocks.length).toBeGreaterThan(5);
    expect(clocks.at(-1)?.playing).toBe(true);
    expect(clocks.at(-1)?.position).not.toBeNull();
    const scopes = w.of("scope");
    expect(scopes.length).toBeGreaterThan(5);
    const last = scopes.at(-1);
    expect(last?.buffers).toHaveLength(10);
    expect(last?.master[0]?.some((v) => v !== 0)).toBe(true);
    // every event object is a copy, with the real fields
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual([
        "channel",
        "channelId",
        "frame",
        "hz",
        "id",
        "note",
        "order",
        "row",
        "type",
        "velocity",
      ]);
    }
    w.send({ type: "stop" });
    w.render(300);
    expect(w.of("error")).toEqual([]);
    // the song was stopped and its release has died away
    expect(w.render(20)).toEqual({ left: 0, right: 0 });
  });

  it("reports a bad document as an error message and keeps working", async () => {
    const w = await load();
    w.send({ instruments: {}, song: { not: "a song" }, type: "loadSong" });
    expect(w.of("error")).toHaveLength(1);
    expect(() => w.render(10)).not.toThrow();
    // the engine is still usable: a good document afterwards plays
    w.send({ id: "coin", sfx, type: "loadSfx" });
    w.send({ handle: 1, id: "coin", type: "trigger", velocity: 1 });
    expect(w.render(40).left).toBeGreaterThan(0.01);
  });
});
