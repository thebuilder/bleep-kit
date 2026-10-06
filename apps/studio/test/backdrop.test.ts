/* The Pixelkit backdrop (section 11.5): every chip's scene is built with the audio reactive layer in it, engine events
   turn into reactive state and taps on the right layers, taps are rate limited, and reduced motion renders one settled
   frame. The canvas records instead of drawing (happy-dom has no 2D context); the renderer is wrapped to record what
   each frame was asked to draw. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type Backdrop, createBackdrop } from "../src/backdrop/index.ts";
import { reactive, resetReactive } from "../src/backdrop/reactive.ts";
import { sceneFor } from "../src/backdrop/scenes/index.ts";
import { CHIP_IDS, type EngineEvent } from "../src/lib/contract.ts";
import { drawLog, installCanvasStub } from "./helpers.ts";

interface Frame {
  t: number;
  taps: { layer?: number; x: number; y: number }[];
}
const frames = vi.hoisted(() => [] as Frame[]);

vi.mock("../src/pixelkit/core/index.ts", async (original) => {
  const core = await original<typeof import("../src/pixelkit/core/index.ts")>();
  return {
    ...core,
    createRenderer: (...args: Parameters<typeof core.createRenderer>) => {
      const renderer = core.createRenderer(...args);
      const render = renderer.render.bind(renderer);
      renderer.render = ((t: number, opts?: { taps?: Frame["taps"] }) => {
        frames.push({ t, taps: [...(opts?.taps ?? [])] });
        return render(t, opts as never);
      }) as typeof renderer.render;
      return renderer;
    },
  };
});

installCanvasStub();

const event = (over: Partial<EngineEvent>): EngineEvent => ({
  channel: -1,
  channelId: "",
  frame: 0,
  hz: 0,
  id: "",
  note: 0,
  order: -1,
  row: -1,
  type: "trigger",
  velocity: 0,
  ...over,
});

const canvas = document.createElement("canvas");
document.body.append(canvas);

/* One backdrop for the whole file: every backdrop listens for window resizes and repaints its whole scene in software
   when one comes, so one per test would make each frame cost the sum of all of them. */
let shared: Backdrop;
beforeAll(() => {
  shared = createBackdrop(canvas);
});

/* The backdrop's rate limiter remembers the last ten seconds, so every test starts on a clock the previous one is out
   of. */
let clock = 0;
const startClock = () => {
  clock += 60_000;
  return clock;
};

/** The shared backdrop on a fresh `chip` scene (a scene change clears its taps), with leftover state cleared. */
function sceneOn(chip: (typeof CHIP_IDS)[number]) {
  if (shared.chip === chip) {
    shared.setChip(chip === "custom" ? "nes" : "custom");
  }
  shared.setChip(chip);
  resetReactive();
  frames.length = 0;
  return shared;
}

/** Make the backdrop paint now, and return what that frame was asked to draw. */
function paintNow(): Frame {
  frames.length = 0;
  window.dispatchEvent(new Event("resize"));
  return frames.at(-1) as Frame;
}

beforeEach(() => {
  delete document.documentElement.dataset.reduced;
});

describe("the scenes", () => {
  // what section 11.5 says each chip's scene is made of; every scene also carries the audio reactive layer
  const SCENES: Record<(typeof CHIP_IDS)[number], string[]> = {
    adlib: ["dust", "glow"],
    c64: ["nebula"],
    custom: [],
    gameboy: ["skyline", "dust"],
    genesis: ["skyline", "embers", "bleep-sea"],
    nes: ["sky", "sparkles"],
    snes: ["nebula", "aurora"],
  };

  for (const chip of CHIP_IDS) {
    it(`builds the ${chip} scene with its generators and the audio reactive layer`, () => {
      const bd = sceneOn(chip);
      expect(bd.chip).toBe(chip);
      const layers = bd.layerTypes();
      expect(layers).toContain("bleep-pulse");
      for (const wanted of SCENES[chip]) {
        expect(layers).toContain(wanted);
      }
    });
  }

  it("never pans the camera, so no scene shifts sideways, and the nes is a still night sky", () => {
    for (const chip of CHIP_IDS) {
      expect(sceneFor(chip).camera.speed, chip).toBe(0);
    }
    const nes = sceneFor("nes").layers.map((l) => l.type);
    expect(nes).not.toContain("skyline");
    expect(nes).not.toContain("fireflies");
  });

  it("draws the new scene to the canvas as soon as the chip changes", () => {
    sceneOn("nes");
    drawLog.length = 0;
    shared.setChip("c64");
    expect(drawLog).toContain("putImageData(3)");
  });

  it("leaves the scene alone when the chip does not change", () => {
    const bd = sceneOn("snes");
    bd.setChip("snes");
    expect(frames).toEqual([]);
    bd.setChip("nes");
    expect(bd.layerTypes()).not.toContain("aurora");
  });

  it("clears the reactive state when the scene changes, so a strike does not carry over", () => {
    const bd = sceneOn("nes");
    bd.handle([event({ channelId: "explosion" })], 0);
    expect(reactive.strikes.length).toBe(1);
    bd.setChip("genesis");
    expect(reactive.strikes).toEqual([]);
  });
});

describe("engine events", () => {
  it("turns triggers, bass notes and bar lines into reactive state", () => {
    const bd = sceneOn("nes");
    let now = 0;
    const feed = (e: Partial<EngineEvent>) => {
      now += 200;
      bd.handle([event(e)], now);
    };
    // explosions and hits are lightning, the big flash only for the explosion
    feed({ channelId: "explosion" });
    feed({ channelId: "hit" });
    expect(reactive.strikes.map((s) => s.big)).toEqual([true, false]);
    // every other sound, and one with no category, is a sparkle burst
    feed({ channelId: "coin" });
    feed({ channelId: "" });
    expect(reactive.bursts.length).toBe(2);
    expect(reactive.strikes.length).toBe(2);
    // only low notes and the bass channels pulse the glow
    feed({ channelId: "lead", note: 72, type: "noteOn" });
    expect(reactive.pulse).toBe(0);
    feed({ channelId: "lead", note: 40, type: "noteOn" });
    expect(reactive.pulse).toBeGreaterThan(0);
    expect(reactive.pulse).toBeLessThan(1);
    feed({ channelId: "triangle", note: 72, type: "noteOn" });
    expect(reactive.pulse).toBe(1);
    // a ring leaves the ground on every fourth row only
    feed({ row: 1, type: "row" });
    feed({ row: 3, type: "row" });
    expect(reactive.rings.length).toBe(0);
    feed({ row: 4, type: "row" });
    expect(reactive.rings.length).toBe(1);
  });

  it("keeps only the newest strikes, bursts and rings", () => {
    const bd = sceneOn("nes");
    const many = (e: Partial<EngineEvent>) =>
      Array.from({ length: 20 }, () => event(e));
    bd.handle(many({ channelId: "explosion" }), 10_000);
    bd.handle(many({ channelId: "coin" }), 10_000);
    bd.handle(many({ row: 8, type: "row" }), 10_000);
    expect(reactive.strikes.length).toBeGreaterThan(0);
    expect(reactive.strikes.length).toBeLessThan(20);
    expect(reactive.bursts.length).toBeGreaterThan(0);
    expect(reactive.bursts.length).toBeLessThan(20);
    expect(reactive.rings.length).toBeGreaterThan(0);
    expect(reactive.rings.length).toBeLessThan(20);
  });

  it("ignores events before it has a scene", () => {
    resetReactive();
    const bd = createBackdrop(document.createElement("canvas"));
    expect(bd.chip).toBeNull();
    bd.handle(
      [
        event({ channelId: "explosion" }),
        event({ channelId: "coin" }),
        event({ row: 4, type: "row" }),
      ],
      0
    );
    expect(bd.layerTypes()).toEqual([]);
    expect(reactive.strikes).toEqual([]);
    expect(reactive.bursts).toEqual([]);
    expect(reactive.rings).toEqual([]);
  });
});

describe("taps into the scene", () => {
  it("lands lightning on the sky layer", () => {
    const bd = sceneOn("nes");
    bd.handle([event({ channelId: "explosion" })], startClock());
    const { taps } = paintNow();
    expect(taps).toHaveLength(1);
    expect(taps[0]?.layer).toBe(bd.layerTypes().indexOf("sky"));
  });

  it("sends sparkles to the embers layer when the scene has one", () => {
    const bd = sceneOn("genesis");
    bd.handle([event({ channelId: "coin" })], startClock());
    const { taps } = paintNow();
    expect(taps).toHaveLength(1);
    expect(taps[0]?.layer).toBe(bd.layerTypes().indexOf("embers"));
  });

  it("lets at most eight taps through in a second, and more once the second is over", () => {
    const bd = sceneOn("nes");
    const t0 = startClock();
    bd.handle(
      Array.from({ length: 30 }, () => event({ channelId: "explosion" })),
      t0
    );
    expect(paintNow().taps.length).toBe(8);
    bd.handle([event({ channelId: "explosion" })], t0 + 500);
    expect(paintNow().taps.length).toBe(8);
    bd.handle([event({ channelId: "explosion" })], t0 + 1100);
    expect(paintNow().taps.length).toBeGreaterThan(8);
  });

  it("renders one settled frame, without taps, under reduced motion", () => {
    const bd = sceneOn("nes");
    bd.handle([event({ channelId: "explosion" })], startClock());
    document.documentElement.dataset.reduced = "1";
    const still = paintNow();
    expect(still.taps).toEqual([]);
    const again = paintNow();
    expect(again.t).toBe(still.t);
  });
});
