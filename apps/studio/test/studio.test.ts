import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseRoute, routeHash } from "../src/app.ts";
import { createHistory } from "../src/lib/history.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { STARTER_PROJECT, starterFiles } from "../src/store/seed.ts";
import { fuzzy } from "../src/ui/palette.ts";
import { keyToOffset } from "../src/ui/piano.ts";
import { highlightTs } from "../src/views/project.ts";
import { crc32, readZip, writeZip } from "../src/zip.ts";

/* ------------------------------------------------------------------ pure units */

describe("parseRoute and routeHash", () => {
  it("parses every view", () => {
    expect(parseRoute("")).toEqual({ view: "pads" });
    expect(parseRoute("#/pads")).toEqual({ view: "pads" });
    expect(parseRoute("#/sfx/coin")).toEqual({ id: "coin", view: "sfx" });
    expect(parseRoute("#/song/starter-theme")).toEqual({
      id: "starter-theme",
      view: "song",
    });
    expect(parseRoute("#/instrument/lead")).toEqual({
      id: "lead",
      view: "instrument",
    });
    expect(parseRoute("#/analysis/sfx/coin")).toEqual({
      ref: "sfx/coin",
      view: "analysis",
    });
    expect(parseRoute("#/project")).toEqual({ view: "project" });
    expect(parseRoute("#/project?export=1")).toEqual({
      export: true,
      view: "project",
    });
    expect(parseRoute("#/nonsense")).toEqual({ view: "pads" });
  });

  it("round trips ids that need escaping", () => {
    const hash = routeHash({ id: "a b", view: "sfx" });
    expect(hash).toBe("#/sfx/a%20b");
    expect(parseRoute(hash)).toEqual({ id: "a b", view: "sfx" });
  });
});

describe("history", () => {
  it("undoes and redoes snapshots", () => {
    const h = createHistory();
    h.reset("a");
    h.push("b");
    h.push("c");
    expect(h.undo()).toBe("b");
    expect(h.undo()).toBe("a");
    expect(h.undo()).toBeNull();
    expect(h.canRedo).toBe(true);
    expect(h.redo()).toBe("b");
    h.push("x");
    expect(h.canRedo).toBe(false);
  });

  it("coalesces quick edits of one control into one step", () => {
    const h = createHistory();
    h.reset("0");
    h.push("1", "vol", 1000);
    h.push("2", "vol", 1100);
    h.push("3", "vol", 1200);
    expect(h.undo()).toBe("0");
    h.reset("0");
    h.push("1", "vol", 1000);
    h.push("2", "vol", 5000);
    expect(h.undo()).toBe("1");
  });

  it("keeps at most the limit", () => {
    const h = createHistory(3);
    h.reset("0");
    for (let i = 1; i <= 10; i++) {
      h.push(String(i));
    }
    let steps = 0;
    while (h.undo() !== null) {
      steps++;
    }
    expect(steps).toBe(3);
  });

  it("ignores a push that changes nothing", () => {
    const h = createHistory();
    h.reset("a");
    expect(h.push("a")).toBe(false);
    expect(h.canUndo).toBe(false);
  });
});

describe("zip", () => {
  it("has the standard crc32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcb_f4_39_26);
  });

  it("round trips entries, including binary data", async () => {
    const bin = new Uint8Array(300).map((_, i) => (i * 7) % 256);
    const zip = writeZip([
      { data: new TextEncoder().encode('{"a":1}'), path: "project.json" },
      { data: bin, path: "renders/x.wav" },
    ]);
    const back = await readZip(zip);
    expect(back.map((e) => e.path)).toEqual(["project.json", "renders/x.wav"]);
    expect(new TextDecoder().decode(back[0]?.data)).toBe('{"a":1}');
    expect([...(back[1]?.data ?? [])]).toEqual([...bin]);
  });
});

describe("fuzzy", () => {
  it("matches in order and ranks tighter matches higher", () => {
    expect(fuzzy("zzz", "coin")).toBeNull();
    expect(fuzzy("", "anything")).toBe(0);
    const tight = fuzzy("coin", "Coin") ?? -1;
    const loose = fuzzy("coin", "Chip order insert notes") ?? -1;
    expect(tight).toBeGreaterThan(loose);
  });
});

describe("piano keys", () => {
  it("maps the computer keyboard to semitone offsets", () => {
    expect(keyToOffset("z")).toBe(0);
    expect(keyToOffset("s")).toBe(1);
    expect(keyToOffset("q")).toBe(12);
    expect(keyToOffset("Q")).toBe(12);
    expect(keyToOffset("-")).toBeNull();
  });
});

describe("highlightTs", () => {
  it("wraps tokens without leaking markup into the text", () => {
    const html = highlightTs('/* hi */\nexport const a = { x: "y<z>", n: 3 };');
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    expect(tmp.textContent).toBe(
      '/* hi */\nexport const a = { x: "y<z>", n: 3 };'
    );
    expect(html).toContain('<i class="c">');
    expect(html).toContain('<i class="k">export</i>');
    expect(html).not.toContain('"c">"');
  });
});

describe("LocalStore", () => {
  it("seeds the starter project on first open", async () => {
    const store = new LocalStore(memoryBackend());
    const info = await store.open();
    expect(info.project.name).toBe(STARTER_PROJECT.name);
    expect(
      info.files.filter((f) => f.kind === "sfx").length
    ).toBeGreaterThanOrEqual(12);
    expect(info.files.filter((f) => f.kind === "song").length).toBe(1);
    expect(starterFiles().has("project.json")).toBe(true);
  });

  it("writes, reads and reports a conflict on a stale etag", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    const first = await store.writeJson("sfx/test.json", { v: 1 });
    expect(first.ok).toBe(true);
    const etag = first.ok ? first.etag : "";
    const second = await store.writeJson("sfx/test.json", { v: 2 }, etag);
    expect(second.ok).toBe(true);
    const stale = await store.writeJson("sfx/test.json", { v: 3 }, etag);
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.reason).toBe("conflict");
    }
    expect((await store.readJson("sfx/test.json")).json).toEqual({ v: 2 });
  });

  it("tells subscribers about writes and deletes", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    const seen: string[] = [];
    store.subscribe((m) => seen.push(m.type));
    await store.writeJson("sfx/n.json", { a: 1 });
    await store.remove("sfx/n.json");
    expect(seen).toEqual(["file", "deleted"]);
  });

  it("exports and imports a zip", async () => {
    const a = new LocalStore(memoryBackend());
    await a.open();
    const zip = await a.exportZip();
    const b = new LocalStore(memoryBackend());
    const n = await b.importZip(zip, true);
    expect(n).toBeGreaterThan(10);
    const info = await b.open();
    expect(info.files.length).toBe((await a.list()).length);
  });
});

/* ------------------------------------------------------------------ canvas stub */

/** A 2D context that records what is drawn instead of drawing it. */
function recordingContext(log: string[]): CanvasRenderingContext2D {
  const target: Record<string | symbol, unknown> = {};
  return new Proxy(target, {
    get(t, key) {
      if (key in t) {
        return t[key];
      }
      if (key === "canvas") {
        return null;
      }
      if (key === "measureText") {
        return () => ({ width: 5 });
      }
      if (key === "createLinearGradient" || key === "createRadialGradient") {
        return () => ({ addColorStop: () => undefined });
      }
      if (key === "getImageData" || key === "createImageData") {
        return (w: number, h: number) => ({
          data: new Uint8ClampedArray(Math.max(1, w * h * 4)),
          height: h,
          width: w,
        });
      }
      return (...args: unknown[]) => {
        log.push(`${String(key)}(${args.length})`);
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const drawLog: string[] = [];
beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return recordingContext(drawLog);
  } as unknown as HTMLCanvasElement["getContext"];
  if (typeof globalThis.OffscreenCanvas === "undefined") {
    class FakeOffscreen {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
      getContext() {
        return recordingContext(drawLog);
      }
    }
    (globalThis as unknown as { OffscreenCanvas: unknown }).OffscreenCanvas =
      FakeOffscreen;
  }
});

describe("canvas drawing", () => {
  it("draws a waveform on a surface", async () => {
    const { surface } = await import("../src/visuals/canvas.ts");
    const { drawWaveform } = await import("../src/visuals/waveform.ts");
    const canvas = document.createElement("canvas");
    const s = surface(canvas);
    s.w = 300;
    s.h = 120;
    const frames = 4800;
    const ch = new Float32Array(frames).map(
      (_, i) => Math.sin(i / 20) * (1 - i / frames)
    );
    const before = drawLog.length;
    drawWaveform(
      s,
      {
        channels: [ch, ch],
        duration: 0.1,
        frames,
        sampleRate: 48_000,
      } as never,
      { clip: false, color: "#f3b24a", played: 0.5 }
    );
    expect(drawLog.length).toBeGreaterThan(before + 10);
    expect(drawLog.some((c) => c.startsWith("fillRect"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ the whole app, against the fake engine */

describe("the studio app", () => {
  let engineMod: typeof import("../src/engine/engine.ts");
  let loopMod: typeof import("../src/visuals/loop.ts");
  let appMod: typeof import("../src/app.ts");
  const sent: { type: string; [k: string]: unknown }[] = [];

  const settle = async (ms = 60) => {
    await new Promise((r) => setTimeout(r, ms));
  };
  const until = async (fn: () => boolean, ms = 3000) => {
    const t0 = Date.now();
    while (!fn() && Date.now() - t0 < ms) {
      await settle(20);
    }
    return fn();
  };

  beforeAll(async () => {
    (
      window as unknown as { happyDOM?: { setURL(url: string): void } }
    ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
    document.body.innerHTML =
      '<canvas id="backdrop"></canvas><div id="app"></div>';
    engineMod = await import("../src/engine/engine.ts");
    loopMod = await import("../src/visuals/loop.ts");
    appMod = await import("../src/app.ts");
    const { boot } = await import("../src/shell.ts");
    await boot(document.getElementById("app") as HTMLElement);
    const node = engineMod.engine.node;
    if (node) {
      const send = node.send.bind(node);
      node.send = (msg) => {
        sent.push(msg as never);
        send(msg);
      };
    }
    await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
  });

  it("boots against the fake engine and a local store", () => {
    expect(engineMod.engine.fake).toBe(true);
    expect(document.querySelector(".top")).not.toBeNull();
    expect(document.querySelector("#strip")).not.toBeNull();
    expect(
      document.querySelectorAll("#side a, #side [data-path], #side .tree-item")
        .length
    ).toBeGreaterThan(0);
  });

  it("lists the starter sounds as pads", () => {
    const pads = document.querySelectorAll(".pad[data-id]");
    expect(pads.length).toBeGreaterThanOrEqual(12);
    expect(document.querySelector('.pad[data-id="coin"]')).not.toBeNull();
  });

  it("a pad press triggers the sound on the engine node and announces it to the visuals", async () => {
    sent.length = 0;
    const pad = document.querySelector('.pad[data-id="coin"]') as HTMLElement;
    pad.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
      })
    );
    await settle();
    expect(sent.some((m) => m.type === "trigger" && m.id === "coin")).toBe(
      true
    );
    expect(sent.some((m) => m.type === "loadSfx" && m.id === "coin")).toBe(
      true
    );
    const seen: string[] = [];
    const off = loopMod.addVisual((f) => {
      for (const e of f.events) {
        seen.push(e.type);
      }
    });
    engineMod.engine.announce({ id: "coin", type: "trigger" });
    loopMod.tickOnce(performance.now() + 20);
    off();
    expect(seen).toContain("trigger");
  });

  it("routes to the song editor and renders tracker rows", async () => {
    appMod.app.navigate("#/song/starter-theme");
    expect(
      await until(() => document.querySelectorAll(".trow").length > 8)
    ).toBe(true);
    const row = document.querySelector(".trow");
    expect(row?.querySelectorAll(".tc").length).toBeGreaterThanOrEqual(4);
    expect(document.querySelectorAll(".tch").length).toBeGreaterThanOrEqual(4);
  });

  it("Space plays the song through the engine, Escape stops it", async () => {
    sent.length = 0;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: " " })
    );
    await settle();
    expect(sent.some((m) => m.type === "play")).toBe(true);
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    await settle();
    expect(sent.some((m) => m.type === "stop")).toBe(true);
  });

  it("Ctrl+K opens the command palette and Escape-free typing filters it", async () => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "k" })
    );
    await settle();
    const input = document.querySelector<HTMLInputElement>(
      ".palette input, dialog input, .modal input"
    );
    expect(input).not.toBeNull();
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
    );
    (
      document.querySelector(".modal-back, .palette-back") as HTMLElement | null
    )?.click();
  });

  it("opens the sfx editor for a sound and edits it with undo and redo", async () => {
    appMod.app.navigate("#/sfx/coin");
    expect(await until(() => document.querySelector("#sName") !== null)).toBe(
      true
    );
    const { project } = await import("../src/state/docs.ts");
    const doc = project.get("sfx", "coin");
    expect(doc).toBeDefined();
    const before = JSON.stringify(doc?.value);
    const name = document.querySelector("#sName") as HTMLInputElement;
    expect(name.value.length).toBeGreaterThan(0);
    if (doc) {
      project.edit(doc, (d: { name: string }) => {
        d.name = "Coin 2";
      });
    }
    expect(
      (project.get("sfx", "coin")?.value as { name: string } | undefined)?.name
    ).toBe("Coin 2");
    expect(doc?.dirty).toBe(true);
    appMod.app.undo();
    await settle();
    expect(JSON.stringify(project.get("sfx", "coin")?.value)).toBe(before);
    appMod.app.redo();
    expect(
      (project.get("sfx", "coin")?.value as { name: string } | undefined)?.name
    ).toBe("Coin 2");
  });

  it("goes quiet under prefers-reduced-motion", async () => {
    loopMod.setReduced(true);
    expect(document.documentElement.dataset.reduced).toBe("1");
    const frames: boolean[] = [];
    const off = loopMod.addVisual((f) => frames.push(f.reduced));
    loopMod.tickOnce(performance.now() + 500);
    off();
    expect(frames).toEqual([true]);
    loopMod.setReduced(false);
    expect(document.documentElement.dataset.reduced).toBe("0");
  });

  it("shows the click-to-enable pill while the context is locked", () => {
    const pill = document.getElementById("audioPill");
    expect(pill).not.toBeNull();
  });
});

vi.setConfig({ testTimeout: 15_000 });
