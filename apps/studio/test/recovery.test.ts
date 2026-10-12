// @vitest-environment node
/* When the engine rebuilds itself (src/engine/recovery.ts): the page hidden for a while, the speakers' sample rate
   changing under an open page, a context that was interrupted or closed. The browser's objects are stand-ins. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EVENT_QUEUE_MAX, EventQueue } from "../src/engine/event-queue.ts";
import {
  AWAY_CHECK_MS,
  DEVICE_SETTLE_MS,
  REBUILD_GAP_MS,
  type RecoveryHost,
  watchRecovery,
} from "../src/engine/recovery.ts";

function setup(initialState = "running", rate = 48_000) {
  let state = initialState;
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as string,
  }) as unknown as Document & { visibilityState: string };
  const win = new EventTarget();
  const devices = new EventTarget();
  const clock = { now: 0 };
  const calls: string[] = [];
  const speakers = { rate };
  const host: RecoveryHost = {
    contextRate: () => 48_000,
    contextState: () => state,
    hide: () => calls.push("hide"),
    probeRate: () => {
      calls.push("probe");
      return Promise.resolve(speakers.rate);
    },
    rebuild: (reason) => {
      calls.push(`rebuild:${reason}`);
      return Promise.resolve();
    },
    show: () => calls.push("show"),
  };
  const recovery = watchRecovery(host, {
    devices,
    doc,
    now: () => clock.now,
    win,
  });
  const visibility = (v: "hidden" | "visible") => {
    doc.visibilityState = v;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return {
    calls,
    clock,
    devices,
    recovery,
    setState: (s: string) => {
      state = s;
    },
    speakers,
    visibility,
    win,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the event queue", () => {
  const ev = (frame: number) => ({ frame }) as never;

  it("is bounded: the oldest events go first", () => {
    const q = new EventQueue();
    q.push(Array.from({ length: EVENT_QUEUE_MAX + 500 }, (_, i) => ev(i)));
    expect(q.length).toBe(EVENT_QUEUE_MAX);
    expect(q.takeDue(Number.POSITIVE_INFINITY)[0]?.frame).toBe(500);
  });

  it("hands out only what has become audible, in order, and clears", () => {
    const q = new EventQueue();
    q.push([ev(1), ev(5), ev(9)]);
    expect(q.takeDue(5).map((e) => e.frame)).toEqual([1, 5]);
    expect(q.takeDue(5)).toEqual([]);
    q.clear();
    expect(q.length).toBe(0);
  });
});

describe("a page that comes back", () => {
  it("is told to hide, and to show again, and only checks the speakers after a long absence", async () => {
    const t = setup();
    t.visibility("hidden");
    t.clock.now = AWAY_CHECK_MS - 1;
    t.visibility("visible");
    expect(t.calls).toEqual(["hide", "show"]);
    t.visibility("hidden");
    t.clock.now += AWAY_CHECK_MS;
    t.visibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["hide", "show", "hide", "show", "probe"]);
  });

  it("rebuilds when the speakers run at another rate than the context", async () => {
    const t = setup();
    t.speakers.rate = 44_100;
    t.visibility("hidden");
    t.clock.now = AWAY_CHECK_MS;
    t.visibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.at(-1)).toBe("rebuild:sample-rate");
  });

  it("rebuilds a context that was closed while away, without asking the speakers", async () => {
    const t = setup();
    t.visibility("hidden");
    t.setState("closed");
    t.visibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["hide", "show", "rebuild:closed"]);
  });

  it("rebuilds a context that was interrupted once it runs again, not while it is still interrupted", async () => {
    const t = setup("interrupted");
    t.recovery.onContextState("interrupted");
    t.visibility("hidden");
    t.visibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["hide", "show"]);
    t.setState("running");
    t.recovery.onContextState("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.at(-1)).toBe("rebuild:interrupted");
  });

  it("treats a page restored from the back/forward cache as a long absence", async () => {
    const t = setup();
    t.speakers.rate = 44_100;
    t.win.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: true })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["show", "probe", "rebuild:sample-rate"]);
    t.win.dispatchEvent(
      Object.assign(new Event("pageshow"), { persisted: false })
    );
    expect(t.calls).toHaveLength(3);
  });
});

describe("output devices coming and going", () => {
  it("checks the speakers once after a burst of device changes", async () => {
    const t = setup();
    t.devices.dispatchEvent(new Event("devicechange"));
    t.devices.dispatchEvent(new Event("devicechange"));
    t.devices.dispatchEvent(new Event("devicechange"));
    expect(t.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    expect(t.calls).toEqual(["probe"]);
  });

  it("rebuilds when headphones changed the rate, and not when the rate is the same", async () => {
    const t = setup();
    t.devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    expect(t.calls).toEqual(["probe"]);
    t.speakers.rate = 16_000;
    t.clock.now += REBUILD_GAP_MS;
    t.devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    expect(t.calls).toEqual(["probe", "probe", "rebuild:sample-rate"]);
  });

  it("does not rebuild twice in a row for one cause", async () => {
    const t = setup();
    t.speakers.rate = 16_000;
    // three device changes, each settling before the next: sequential on purpose
    for (let i = 0; i < 3; i += 1) {
      t.devices.dispatchEvent(new Event("devicechange"));
      // biome-ignore lint/performance/noAwaitInLoops: each change must settle before the next one arrives
      await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    }
    expect(t.calls.filter((c) => c.startsWith("rebuild"))).toHaveLength(1);
  });

  it("puts a rebuild that comes too soon off until the gap is over, instead of losing it", async () => {
    const t = setup();
    t.speakers.rate = 16_000;
    t.devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    expect(t.calls.filter((c) => c.startsWith("rebuild"))).toHaveLength(1);
    t.clock.now += 500;
    t.setState("closed");
    t.recovery.onContextState("closed");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls.filter((c) => c.startsWith("rebuild"))).toHaveLength(1);
    // the clock the policy reads is the stand-in's; the timer is the real (fake) one
    t.clock.now += REBUILD_GAP_MS;
    await vi.advanceTimersByTimeAsync(REBUILD_GAP_MS);
    expect(t.calls.at(-1)).toBe("rebuild:closed");
  });

  it("checks the speakers when a suspended context runs again, but not the first time it runs", async () => {
    const t = setup("suspended");
    t.recovery.onContextState("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual([]);
    t.recovery.onContextState("suspended");
    t.recovery.onContextState("running");
    await vi.advanceTimersByTimeAsync(0);
    expect(t.calls).toEqual(["probe"]);
  });

  it("stops listening when disposed", async () => {
    const t = setup();
    t.recovery.dispose();
    t.visibility("hidden");
    t.devices.dispatchEvent(new Event("devicechange"));
    await vi.advanceTimersByTimeAsync(DEVICE_SETTLE_MS);
    expect(t.calls).toEqual([]);
  });
});
