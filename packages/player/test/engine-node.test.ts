import type { FromWorklet, ToWorklet } from "@bleepkit/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEngineNode } from "../src/engine-node.ts";
import { sharedScopeBytes } from "../src/scope.ts";
import {
  FakeContext,
  FakeWorkletNode,
  installWebAudioGlobals,
} from "./fake-audio.ts";

const DEFAULT_WORKLET = /worklet\/bleepkit-worklet\.js$/;

function setup() {
  const Node = installWebAudioGlobals();
  vi.stubGlobal("AudioWorkletNode", Node);
  const ctx = new FakeContext();
  return { as: ctx.asContext(), ctx, Node };
}

beforeEach(() => {
  vi.useRealTimers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  FakeWorkletNode.hook = null;
});

describe("createEngineNode: loading", () => {
  it("adds the module, builds a stereo source node and waits for ready", async () => {
    const { Node, ctx, as } = setup();
    const engine = await createEngineNode(as, {
      sfxVoices: 6,
      workletUrl: "/w/worklet.js",
    });
    expect(ctx.modules).toEqual(["/w/worklet.js"]);
    const [node] = Node.instances;
    expect(node?.name).toBe("bleepkit-engine");
    expect(node?.options).toMatchObject({
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { scopeFrames: 2048, scopes: true, sfxVoices: 6 },
    });
    expect(engine.node).toBe(node);
    expect(engine.sampleRate).toBe(48_000);
  });

  it("accepts a URL and falls back to the file next to the package", async () => {
    const a = setup();
    await createEngineNode(a.as, {
      workletUrl: new URL("https://example.com/x/w.js"),
    });
    expect(a.ctx.modules).toEqual(["https://example.com/x/w.js"]);
    const b = setup();
    await createEngineNode(b.as);
    expect(b.ctx.modules[0]).toMatch(DEFAULT_WORKLET);
  });

  it("explains a module that cannot be loaded", async () => {
    const { ctx, as } = setup();
    ctx.moduleError = "404";
    await expect(
      createEngineNode(as, { workletUrl: "/nope.js" })
    ).rejects.toThrow("could not load the Bleepkit worklet from /nope.js: 404");
  });

  it("rejects when the processor reports an error before ready", async () => {
    const { Node, as } = setup();
    Node.hook = (node) =>
      node.port.emit({ message: "engine missing", type: "error" });
    await expect(createEngineNode(as)).rejects.toThrow("engine missing");
    expect(Node.instances[0]?.disconnected).toBe(true);
  });

  it("rejects when the processor fails to start", async () => {
    const { Node, as } = setup();
    Node.hook = (node) => queueMicrotask(() => node.onprocessorerror?.());
    await expect(createEngineNode(as)).rejects.toThrow("failed to start");
    expect(Node.instances[0]?.disconnected).toBe(true);
  });

  it("gives up when the worklet never answers", async () => {
    vi.useFakeTimers();
    const { Node, as } = setup();
    Node.hook = () => undefined;
    const pending = createEngineNode(as);
    const assertion = expect(pending).rejects.toThrow("did not answer");
    await vi.advanceTimersByTimeAsync(9000);
    await assertion;
    expect(Node.instances[0]?.disconnected).toBe(true);
  });
});

describe("EngineNode: messages", () => {
  it("posts what it is sent to the worklet port", async () => {
    const { Node, as } = setup();
    const engine = await createEngineNode(as);
    const msg: ToWorklet = { loop: true, type: "play" };
    engine.send(msg);
    expect(Node.instances[0]?.port.sent).toEqual([msg]);
  });

  it("delivers worklet messages to every handler until it unsubscribes, whatever another handler does", async () => {
    const { Node, as } = setup();
    const engine = await createEngineNode(as);
    const [node] = Node.instances;
    // a listener that throws comes first: the ones after it must still hear the message, and the clock still updates
    engine.on(() => {
      throw new Error("bad listener");
    });
    const got: FromWorklet[] = [];
    const off = engine.on((m) => got.push(m));
    node?.port.emit({ type: "ended" });
    node?.port.emit(null);
    node?.port.emit("junk");
    expect(got).toEqual([{ type: "ended" }]);
    node?.port.emit({
      frame: 7,
      playing: false,
      position: null,
      time: 1,
      type: "clock",
    });
    expect(engine.lastClock()?.frame).toBe(7);
    expect(got).toHaveLength(2);
    off();
    node?.port.emit({ type: "ended" });
    expect(got).toHaveLength(2);
  });

  it("stops everything on dispose", async () => {
    const { Node, as } = setup();
    const engine = await createEngineNode(as);
    const [node] = Node.instances;
    const got: FromWorklet[] = [];
    engine.on((m) => got.push(m));
    const sentBefore = node?.port.sent.length ?? 0;
    engine.dispose();
    engine.dispose();
    engine.send({ type: "stop" });
    expect(node?.port.sent).toHaveLength(sentBefore);
    expect(node?.port.onmessage).toBeNull();
    expect(node?.port.closed).toBe(true);
    expect(node?.disconnected).toBe(true);
    expect(got).toEqual([]);
  });
});

describe("EngineNode: the audio clock", () => {
  it("is 0 before the first clock message", async () => {
    const { as } = setup();
    const engine = await createEngineNode(as);
    expect(engine.nowFrame()).toBe(0);
    expect(engine.lastClock()).toBeNull();
    expect(engine.cpuLoad()).toBe(0);
  });

  it("maps clock + currentTime - outputLatency to the frame being heard", async () => {
    const { Node, ctx, as } = setup();
    const engine = await createEngineNode(as);
    const clock = {
      frame: 1000,
      load: 0.25,
      playing: true,
      position: null,
      time: 2,
      type: "clock",
    };
    Node.instances[0]?.port.emit(clock);
    ctx.currentTime = 2.5;
    // 0.5 s of rendering since the clock, minus 50 ms still in the output pipeline
    expect(engine.nowFrame()).toBeCloseTo(1000 + 0.45 * 48_000, 6);
    expect(engine.cpuLoad()).toBe(0.25);
    expect(engine.lastClock()).toEqual(clock);
    expect(engine.outputLatency()).toBe(0.05);
  });

  it("falls back to baseLatency when outputLatency is unknown (Safari)", async () => {
    const { Node, ctx, as } = setup();
    const engine = await createEngineNode(as);
    ctx.outputLatency = 0;
    expect(engine.outputLatency()).toBe(0.01);
    Reflect.deleteProperty(ctx, "outputLatency");
    expect(engine.outputLatency()).toBe(0.01);
    Node.instances[0]?.port.emit({
      frame: 0,
      playing: false,
      position: null,
      time: 1,
      type: "clock",
    });
    ctx.currentTime = 1;
    expect(engine.nowFrame()).toBeCloseTo(-0.01 * 48_000, 6);
  });

  it("converts an engine frame to the context time it is audible", async () => {
    const { Node, as } = setup();
    const engine = await createEngineNode(as);
    // an events message carries its own pair
    expect(
      engine.frameToTime(48_000 + 4800, { clockFrame: 48_000, clockTime: 3 })
    ).toBeCloseTo(3 + 0.1 + 0.05, 9);
    Node.instances[0]?.port.emit({
      frame: 96_000,
      playing: true,
      position: null,
      time: 5,
      type: "clock",
    });
    expect(engine.frameToTime(96_000 + 24_000)).toBeCloseTo(5.5 + 0.05, 9);
  });
});

describe("EngineNode: scopes", () => {
  it("feeds the reader from posted copies without cross-origin isolation", async () => {
    const { Node, as } = setup();
    const engine = await createEngineNode(as);
    expect(Node.instances[0]?.port.sent).toEqual([]);
    const ramp = Float32Array.from({ length: 1024 }, (_, i) => i);
    Node.instances[0]?.port.emit({
      buffers: [ramp],
      frame: 1024,
      master: [ramp, ramp],
      type: "scope",
    });
    expect(Array.from(engine.scopes.latest(0, 3))).toEqual([1021, 1022, 1023]);
    expect(Array.from(engine.scopes.at(-1, 0, 2))).toEqual([0, 1]);
  });

  it("uses a SharedArrayBuffer when the page is cross-origin isolated", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const { Node, as } = setup();
    const engine = await createEngineNode(as, { scopeFrames: 256 });
    const [sent] = Node.instances[0]?.port.sent ?? [];
    const message = sent as { type: string; buffer: SharedArrayBuffer };
    expect(message.type).toBe("setScopeBuffer");
    expect(message.buffer.byteLength).toBe(sharedScopeBytes(256));
    // the synth writes into the buffer; the reader sees it
    const head = new Uint32Array(message.buffer, 0, 1);
    const channel2 = new Float32Array(message.buffer, 4 + 4 * 256 * 2, 256);
    channel2[255] = 0.5;
    head[0] = 0;
    expect(engine.scopes.latest(2, 1)[0]).toBe(0.5);
  });

  it("can be told to share nothing or to skip scopes", async () => {
    vi.stubGlobal("crossOriginIsolated", true);
    const a = setup();
    await createEngineNode(a.as, { shared: false });
    expect(a.Node.instances[0]?.port.sent).toEqual([]);
    const b = setup();
    await createEngineNode(b.as, { scopes: false });
    expect(b.Node.instances[0]?.port.sent).toEqual([]);
    expect(b.Node.instances[0]?.options.processorOptions).toMatchObject({
      scopes: false,
    });
  });
});
