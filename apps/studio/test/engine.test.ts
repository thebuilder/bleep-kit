/* The real engine must be wired to the speakers. createEngineNode leaves routing to its caller, and a studio that
   forgets to connect it still animates every scope (they read the engine's own rings) while playing nothing. */
import { afterEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();

vi.mock("@bleepkit/player", () => ({
  createEngineNode: vi.fn(async () => ({
    dispose: vi.fn(),
    node: { connect },
    nowFrame: () => 0,
    on: () => () => undefined,
    scopes: {
      at: () => new Float32Array(0),
      latest: () => new Float32Array(0),
    },
    send: vi.fn(),
  })),
}));

class FakeContext {
  readonly destination = { kind: "destination" };
  readonly sampleRate = 48_000;
  state = "suspended";
  addEventListener(): void {
    // the engine listens for statechange; nothing changes here
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("engine routing", () => {
  it("connects the real engine node to the context destination", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const { engine } = await import("../src/engine/engine.ts");
    await engine.init({ fake: false });
    // the worklet bundle is built by Turbo before the studio's tests; without it the studio falls back to the fake
    expect(engine.fake).toBe(false);
    expect(connect).toHaveBeenCalledWith(engine.ctx?.destination);
  });
});
