/* The Pixelkit backdrop: every chip's scene renders, engine events turn into taps and reactive state, and the taps are
   rate limited. The canvas records instead of drawing (happy-dom has no 2D context). */
import { describe, expect, it } from "vitest";
import { createBackdrop } from "../src/backdrop/index.ts";
import { reactive } from "../src/backdrop/reactive.ts";
import { CHIP_IDS, type EngineEvent } from "../src/lib/contract.ts";
import { installCanvasStub, settle } from "./helpers.ts";

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

describe("the backdrop", () => {
  const canvas = document.createElement("canvas");
  document.body.append(canvas);

  it("builds a scene for every chip, crossfading from the last", async () => {
    const bd = createBackdrop(canvas);
    expect(bd.chip).toBeNull();
    for (const chip of CHIP_IDS) {
      bd.setChip(chip);
      bd.setChip(chip);
      expect(bd.chip).toBe(chip);
      expect(bd.layerTypes().length).toBeGreaterThan(0);
      window.dispatchEvent(new Event("resize"));
    }
    await settle(30);
  });

  it("turns triggers, bass notes and bar lines into reactive state", () => {
    const bd = createBackdrop(canvas);
    bd.handle([event({ channelId: "explosion" })], 0);
    bd.setChip("nes");
    window.dispatchEvent(new Event("resize"));
    reactive.strikes.length = 0;
    reactive.bursts.length = 0;
    reactive.rings.length = 0;
    reactive.pulse = 0;
    let now = 0;
    const feed = (e: Partial<EngineEvent>) => {
      now += 200;
      bd.handle([event(e)], now);
    };
    feed({ channelId: "explosion" });
    feed({ channelId: "hit" });
    expect(reactive.strikes.length).toBe(2);
    expect(reactive.strikes[0]?.big).toBe(true);
    expect(reactive.strikes[1]?.big).toBe(false);
    feed({ channelId: "coin" });
    feed({ channelId: "" });
    expect(reactive.bursts.length).toBe(2);
    feed({ channelId: "lead", note: 72, type: "noteOn" });
    expect(reactive.pulse).toBe(0);
    feed({ channelId: "lead", note: 40, type: "noteOn" });
    expect(reactive.pulse).toBeCloseTo(0.7);
    feed({ channelId: "triangle", note: 72, type: "noteOn" });
    expect(reactive.pulse).toBe(1);
    feed({ row: 1, type: "row" });
    expect(reactive.rings.length).toBe(0);
    feed({ row: 4, type: "row" });
    expect(reactive.rings.length).toBe(1);
  });

  it("keeps only the newest strikes, bursts and rings", () => {
    const bd = createBackdrop(canvas);
    bd.setChip("nes");
    window.dispatchEvent(new Event("resize"));
    const many = (e: Partial<EngineEvent>) =>
      Array.from({ length: 20 }, () => event(e));
    bd.handle(many({ channelId: "explosion" }), 10_000);
    bd.handle(many({ channelId: "coin" }), 10_000);
    bd.handle(many({ row: 8, type: "row" }), 10_000);
    expect(reactive.strikes.length).toBeLessThanOrEqual(6);
    expect(reactive.bursts.length).toBeLessThanOrEqual(8);
    expect(reactive.rings.length).toBeLessThanOrEqual(5);
  });

  it("does nothing with events before it has a scene", () => {
    const bd = createBackdrop(document.createElement("canvas"));
    bd.handle([event({ channelId: "explosion" })], 0);
    expect(bd.layerTypes()).toEqual([]);
  });
});
