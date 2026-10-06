import { beforeAll, describe, expect, it, vi } from "vitest";
import { parseRoute, routeHash } from "../src/app.ts";
import { createHistory } from "../src/lib/history.ts";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { STARTER_PROJECT, starterFiles } from "../src/store/seed.ts";
import { fieldLabel, issuesBox } from "../src/ui/issues.ts";
import { fuzzy } from "../src/ui/palette.ts";
import { keyToOffset } from "../src/ui/piano.ts";
import { highlightTs } from "../src/views/project.ts";
import { crc32, readZip, writeZip } from "../src/zip.ts";
import {
  field,
  filledRects,
  installCanvasStub,
  setRange,
  settle,
  until,
} from "./helpers.ts";

installCanvasStub();

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
    for (let i = 1; i <= 10; i += 1) {
      h.push(String(i));
    }
    let steps = 0;
    while (h.undo() !== null) {
      steps += 1;
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
  // the tracker's two rows from section 11.2: lower octave Z S X D C V G B H N J M, upper Q 2 W 3 E R 5 T 6 Y 7 U
  it("maps both rows of the computer keyboard to consecutive semitones, either case", () => {
    for (const [row, base] of [
      ["ZSXDCVGBHNJM", 0],
      ["Q2W3ER5T6Y7U", 12],
    ] as const) {
      for (const [i, k] of [...row].entries()) {
        expect(keyToOffset(k)).toBe(base + i);
        expect(keyToOffset(k.toLowerCase())).toBe(base + i);
      }
    }
  });

  it("leaves the keys that mean something else alone", () => {
    // 1 is note off and ` is release in the tracker
    for (const k of ["1", "`", "-", "=", " ", "Enter", "ArrowUp"]) {
      expect(keyToOffset(k)).toBeNull();
    }
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
    expect(
      info.files.filter((f) => f.kind === "instrument").length
    ).toBeGreaterThanOrEqual(7);
    expect(info.files.some((f) => f.path === "project.json")).toBe(true);
  });

  it("does not overwrite a project that is already there when it opens again", async () => {
    const backend = memoryBackend();
    const first = new LocalStore(backend);
    await first.open();
    await first.writeJson("sfx/coin.json", { mine: true });
    await new LocalStore(backend).open();
    expect((await first.readJson("sfx/coin.json")).json).toEqual({
      mine: true,
    });
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
    expect(stale).toMatchObject({
      json: { v: 2 },
      ok: false,
      reason: "conflict",
    });
    expect((await store.readJson("sfx/test.json")).json).toEqual({ v: 2 });
    // leaving the etag out overwrites, which is what "Keep mine" does
    expect((await store.writeJson("sfx/test.json", { v: 4 })).ok).toBe(true);
    expect((await store.readJson("sfx/test.json")).json).toEqual({ v: 4 });
  });

  it("tells subscribers about writes and deletes, with the etag the writer got back", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    const seen: { etag?: string; path: string; type: string }[] = [];
    store.subscribe((m) => seen.push(m as never));
    const res = await store.writeJson("sfx/n.json", { a: 1 });
    await store.remove("sfx/n.json");
    expect(seen.map((m) => [m.type, m.path])).toEqual([
      ["file", "sfx/n.json"],
      ["deleted", "sfx/n.json"],
    ]);
    // the message carries the etag the writer got back, which is how the project can tell its own write from an outside
    // one (it does not yet: see the echo bug in docs.test.ts)
    expect(res.ok && seen[0]?.etag).toBe(res.ok ? res.etag : "");
    // and the delete took the file away
    await expect(store.readJson("sfx/n.json")).rejects.toThrow();
    expect((await store.list()).map((f) => f.path)).not.toContain("sfx/n.json");
  });

  it("exports a zip another browser project can import, with every document intact", async () => {
    const a = new LocalStore(memoryBackend());
    await a.open();
    await a.writeJson("sfx/extra.json", { edited: "by the user" });
    const zip = await a.exportZip();
    const b = new LocalStore(memoryBackend());
    const n = await b.importZip(zip, true);
    const paths = (await a.list()).map((f) => f.path).sort();
    expect(n).toBe(paths.length);
    expect((await b.list()).map((f) => f.path).sort()).toEqual(paths);
    for (const path of paths) {
      // biome-ignore lint/performance/noAwaitInLoops: one comparison at a time keeps a failure readable
      expect((await b.readJson(path)).json).toEqual(
        (await a.readJson(path)).json
      );
    }
  });

  it("imports a zip made from a folder with one top-level directory", async () => {
    const a = new LocalStore(memoryBackend());
    await a.open();
    const zip = writeZip([
      {
        data: new TextEncoder().encode(
          JSON.stringify({ envelope: {}, frequency: {} })
        ),
        path: "my-game/sfx/boom.json",
      },
      { data: new TextEncoder().encode("junk"), path: "my-game/readme.txt" },
    ]);
    expect(await a.importZip(zip, false)).toBe(1);
    expect((await a.list()).some((f) => f.path === "sfx/boom.json")).toBe(true);
  });
});

describe("canvas drawing", () => {
  const sine = (amp: number) => {
    const frames = 4800;
    const ch = new Float32Array(frames).map((_, i) => Math.sin(i / 20) * amp);
    return {
      channels: [ch, ch],
      duration: 0.1,
      frames,
      sampleRate: 48_000,
    } as never;
  };
  const COLOR = "#f3b24a";
  const DIM = "rgba(243,178,74,0.55)";
  const draw = async (amp: number, played = -1) => {
    const { surface } = await import("../src/visuals/canvas.ts");
    const { drawWaveform } = await import("../src/visuals/waveform.ts");
    const s = surface(document.createElement("canvas"));
    s.w = 300;
    s.h = 120;
    filledRects.length = 0;
    drawWaveform(s, sine(amp), { clip: false, color: COLOR, played });
    return filledRects.filter(
      (r) => r.w === 2 && (r.style === COLOR || r.style === DIM)
    );
  };

  it("draws a loud sound over the full height of the plot and a quiet one near its middle line", async () => {
    // the plot is the surface minus a 16 px time axis: 104 px tall with the middle line at 52
    const loud = await draw(1);
    const quiet = await draw(0.1);
    expect(Math.min(...loud.map((r) => r.y))).toBeLessThanOrEqual(4);
    expect(Math.max(...loud.map((r) => r.y + r.h))).toBeGreaterThanOrEqual(100);
    expect(Math.min(...quiet.map((r) => r.y))).toBeGreaterThanOrEqual(44);
    expect(Math.max(...quiet.map((r) => r.y + r.h))).toBeLessThanOrEqual(60);
  });

  it("lights the part already played and dims the rest", async () => {
    const bars = await draw(1, 0.5);
    const lit = bars.filter((r) => r.style === COLOR);
    const dim = bars.filter((r) => r.style === DIM);
    expect(lit.length).toBeGreaterThan(30);
    expect(dim.length).toBeGreaterThan(30);
    expect(Math.max(...lit.map((r) => r.x))).toBeLessThanOrEqual(150);
    expect(Math.min(...dim.map((r) => r.x))).toBeGreaterThan(150);
  });
});

/* ------------------------------------------------------------------ the whole app, against the fake engine */

describe("the studio app", () => {
  let engineMod: typeof import("../src/engine/engine.ts");
  let loopMod: typeof import("../src/visuals/loop.ts");
  let appMod: typeof import("../src/app.ts");
  let docsMod: typeof import("../src/state/docs.ts");
  /** Every message the studio has sent its engine node since boot, oldest first. */
  const sent: { type: string; [k: string]: unknown }[] = [];
  const sentSince = (mark: number, type?: string) =>
    sent.slice(mark).filter((m) => !type || m.type === type);

  // the loop reads prefers-reduced-motion once and then follows this query's change events
  const reducedQuery = {
    listeners: [] as ((e: { matches: boolean }) => void)[],
    matches: false,
  };

  const key = (
    k: string,
    init: KeyboardEventInit = {},
    el: Element = document.body
  ) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: k,
        ...init,
      })
    );
  const go = async (hash: string, ready: () => boolean) => {
    appMod.app.navigate(hash);
    expect(await until(ready)).toBe(true);
    // a hashchange queued by an earlier navigation lands after this one; let it, so it cannot remount the view mid-test
    await settle(30);
  };
  const press = (el: Element | null) => {
    expect(el).not.toBeNull();
    (el as HTMLElement).click();
  };
  const sidebarRow = (href: string) =>
    [...document.querySelectorAll<HTMLElement>("#side .tree-item")].find(
      (row) => row.querySelector("a")?.getAttribute("href") === href
    ) ?? null;

  beforeAll(async () => {
    vi.stubGlobal("matchMedia", (media: string) => ({
      addEventListener: (
        _type: string,
        fn: (e: { matches: boolean }) => void
      ) => reducedQuery.listeners.push(fn),
      matches: reducedQuery.matches && media.includes("reduce"),
      media,
      removeEventListener: () => undefined,
    }));
    (
      window as unknown as { happyDOM?: { setURL: (url: string) => void } }
    ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
    document.body.innerHTML =
      '<canvas id="backdrop"></canvas><div id="app"></div>';
    engineMod = await import("../src/engine/engine.ts");
    loopMod = await import("../src/visuals/loop.ts");
    appMod = await import("../src/app.ts");
    docsMod = await import("../src/state/docs.ts");
    const { boot } = await import("../src/shell.ts");
    await boot(document.getElementById("app") as HTMLElement);
    const { node } = engineMod.engine;
    if (node) {
      const send = node.send.bind(node);
      node.send = (msg) => {
        sent.push(msg as never);
        send(msg);
      };
    }
    await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
  });

  it("boots on the fake engine and shows the starter project as pads and in the sidebar", () => {
    expect(engineMod.engine.fake).toBe(true);
    const { project } = docsMod;
    const sfxIds = project.list("sfx").map((d) => d.id);
    expect(sfxIds.length).toBeGreaterThanOrEqual(12);
    const padIds = [
      ...document.querySelectorAll<HTMLElement>(".pad[data-id]"),
    ].map((p) => p.dataset.id);
    expect(padIds.sort()).toEqual([...sfxIds].sort());
    const links = [...document.querySelectorAll("#side a.tl")].map((a) =>
      a.getAttribute("href")
    );
    for (const id of sfxIds) {
      expect(links).toContain(`#/sfx/${id}`);
    }
    expect(links).toContain("#/song/starter-theme");
    expect(links.filter((l) => l?.startsWith("#/instrument/")).length).toBe(
      project.list("instrument").length
    );
    expect(document.querySelector("#strip")).not.toBeNull();
  });

  it("a pad press uploads the sound as it is in the project, triggers it, and announces it to the visuals", () => {
    const mark = sent.length;
    const seen: { id: string; type: string }[] = [];
    const off = loopMod.addVisual((f) => {
      for (const e of f.events) {
        seen.push(e);
      }
    });
    const pad = document.querySelector('.pad[data-id="coin"]') as HTMLElement;
    pad.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        pointerId: 1,
      })
    );
    loopMod.tickOnce(performance.now() + 20);
    off();
    const doc = docsMod.project.get("sfx", "coin");
    const upload = sentSince(mark, "loadSfx").find((m) => m.id === "coin");
    // an earlier test may have uploaded this exact sound already; then only the trigger goes out
    if (upload) {
      expect(upload.sfx).toEqual(doc?.value);
    } else {
      expect(sent.some((m) => m.type === "loadSfx" && m.id === "coin")).toBe(
        true
      );
    }
    expect(sentSince(mark, "trigger").map((m) => m.id)).toEqual(["coin"]);
    expect(seen.filter((e) => e.type === "trigger").map((e) => e.id)).toEqual([
      "coin",
    ]);
  });

  it("the play buttons in the sidebar sound a sound effect, a song and an instrument", () => {
    const mark = sent.length;
    press(sidebarRow("#/sfx/coin")?.querySelector(".pl") ?? null);
    expect(sentSince(mark, "trigger").map((m) => m.id)).toEqual(["coin"]);

    const songMark = sent.length;
    press(sidebarRow("#/song/starter-theme")?.querySelector(".pl") ?? null);
    expect(sentSince(songMark).map((m) => m.type)).toContain("play");
    expect(
      sent.some(
        (m) =>
          m.type === "loadSong" &&
          JSON.stringify(m.song) ===
            JSON.stringify(docsMod.project.get("song", "starter-theme")?.value)
      )
    ).toBe(true);
    key("Escape");

    const [inst] = docsMod.project.list("instrument");
    const instMark = sent.length;
    press(sidebarRow(`#/instrument/${inst?.id}`)?.querySelector(".pl") ?? null);
    const instSent = sentSince(instMark);
    expect(instSent.map((m) => m.type)).toContain("noteOn");
    expect(instSent.find((m) => m.type === "noteOn")?.instrument).toBe(
      inst?.id
    );
    appMod.app.navigate("#/pads");
  });

  it("plays what the CLI asks for, opening it first when the request is visual", () => {
    const mark = sent.length;
    docsMod.project.onRemotePlay?.("sfx/coin", false);
    expect(sentSince(mark, "trigger").map((m) => m.id)).toEqual(["coin"]);
    docsMod.project.onRemotePlay?.("sfx/jump", true);
    expect(location.hash).toBe("#/sfx/jump");
    expect(sentSince(mark, "trigger").map((m) => m.id)).toEqual([
      "coin",
      "jump",
    ]);
    const before = sent.length;
    docsMod.project.onRemotePlay?.("sfx/no-such-sound", true);
    expect(sent.length).toBe(before);
    expect(document.getElementById("toast")?.textContent).toContain(
      "Cannot play sfx/no-such-sound"
    );
    appMod.app.navigate("#/pads");
  });

  it("routes to the song editor and draws the pattern: its rows and a header per channel", async () => {
    const song = docsMod.project.get("song", "starter-theme")?.value as {
      channels: unknown[];
      order: string[];
      patterns: Record<string, { length: number }>;
    };
    await go(
      "#/song/starter-theme",
      () => document.querySelectorAll(".trow").length > 8
    );
    const first = song.order[0] as string;
    expect(document.querySelectorAll(".trow").length).toBe(
      song.patterns[first]?.length
    );
    expect(document.querySelectorAll(".tch").length).toBe(song.channels.length);
    expect(
      document.querySelector(".trow")?.querySelectorAll(".tc").length
    ).toBe(song.channels.length);
  });

  it("Space plays the song through the engine, Escape stops it", async () => {
    await go(
      "#/song/starter-theme",
      () => document.querySelectorAll(".trow").length > 8
    );
    const mark = sent.length;
    key(" ");
    expect(sentSince(mark).map((m) => m.type)).toContain("play");
    expect(engineMod.engine.playing).toBe(true);
    key("Escape");
    expect(sentSince(mark).map((m) => m.type)).toContain("stop");
    expect(engineMod.engine.playing).toBe(false);
  });

  it("Ctrl+K opens the command palette, typing narrows it to what matches, and Enter runs the first match", async () => {
    appMod.app.navigate("#/pads");
    key("k", { ctrlKey: true });
    const input = document.querySelector<HTMLInputElement>(
      '.overlay input[aria-label="Command"]'
    );
    expect(input).not.toBeNull();
    const titles = () =>
      [...document.querySelectorAll(".overlay .cmd .nm")].map(
        (n) => n.textContent
      );
    const all = titles().length;
    expect(all).toBeGreaterThan(5);
    (input as HTMLInputElement).value = "coin";
    input?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(titles()[0]).toBe("Coin");
    expect(titles().length).toBeLessThan(all);
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
    );
    expect(await until(() => location.hash === "#/sfx/coin")).toBe(true);
    expect(await until(() => document.querySelector("#sName") !== null)).toBe(
      true
    );
    expect(document.querySelector(".overlay")).toBeNull();
  });

  it("changes made in the sfx editor reach the project, the engine and the store, and undo and redo them", async () => {
    await go("#/sfx/coin", () => document.querySelector("#sName") !== null);
    const { project } = docsMod;
    const coin = () => project.get("sfx", "coin");
    const volume = () =>
      ((coin() as { value: unknown }).value as { volume: number }).volume;
    const original = volume();
    const insp = document.getElementById("insp") as HTMLElement;
    const mark = sent.length;

    setRange(field(insp, "Volume"), 0.31);
    expect(volume()).toBe(0.31);
    expect(coin()?.dirty).toBe(true);

    // "Play on every change" sounds the edited sound: the engine is handed the new version before the trigger
    expect(
      await until(() => sentSince(mark, "trigger").some((m) => m.id === "coin"))
    ).toBe(true);
    const upload = sentSince(mark, "loadSfx").find((m) => m.id === "coin");
    expect(upload?.sfx).toMatchObject({ volume: 0.31 });

    // Ctrl+S puts it in the store
    key("s", { ctrlKey: true });
    expect(await until(() => coin()?.dirty === false)).toBe(true);
    const stored = async () =>
      (
        (await project.store.readJson("sfx/coin.json")).json as {
          volume: number;
        }
      ).volume;
    expect(await stored()).toBe(0.31);

    key("z", { ctrlKey: true });
    expect(volume()).toBe(original);
    expect((field(insp, "Volume") as HTMLInputElement).value).toBe(
      String(original)
    );
    key("z", { ctrlKey: true, shiftKey: true });
    expect(volume()).toBe(0.31);

    // leave the starter sound as it was for the tests after this one
    key("z", { ctrlKey: true });
    key("s", { ctrlKey: true });
    expect(await until(() => coin()?.dirty === false)).toBe(true);
    expect(await stored()).toBe(original);
  });

  /* Section 6.3: a save with a stale etag gets the changed-on-disk bar, and Keep mine is the only way to overwrite.
     Ctrl+S keeps the etag check like autosave does. */
  it("Ctrl+S does not silently overwrite a change made on disk", async () => {
    await go("#/sfx/coin", () => document.querySelector("#sName") !== null);
    const { project } = docsMod;
    const insp = document.getElementById("insp") as HTMLElement;
    setRange(field(insp, "Volume"), 0.31);
    const onDisk = {
      ...((await project.store.readJson("sfx/coin.json")).json as object),
      volume: 0.9,
    };
    await project.store.writeJson("sfx/coin.json", onDisk);
    await until(() => project.get("sfx", "coin")?.conflict !== null);
    key("s", { ctrlKey: true });
    await settle(100);
    const stored = (await project.store.readJson("sfx/coin.json")).json as {
      volume: number;
    };
    expect(stored.volume).toBe(0.9);
  });

  it("goes quiet under prefers-reduced-motion", () => {
    const setReduced = (on: boolean) => {
      reducedQuery.matches = on;
      for (const fn of reducedQuery.listeners) {
        fn({ matches: on });
      }
    };
    setReduced(true);
    expect(document.documentElement.dataset.reduced).toBe("1");
    const frames: boolean[] = [];
    const off = loopMod.addVisual((f) => frames.push(f.reduced));
    loopMod.tickOnce(performance.now() + 500);
    off();
    expect(frames).toEqual([true]);
    setReduced(false);
    expect(document.documentElement.dataset.reduced).toBe("0");
  });

  it("asks for a click while the audio context is locked, and the first click anywhere unlocks it", async () => {
    const { engine } = engineMod;
    const pill = document.getElementById("audioPill") as HTMLElement;
    // happy-dom has no AudioContext, so there is nothing to unlock yet
    expect(pill.hidden).toBe(true);
    const ctx = {
      addEventListener: () => undefined,
      resume: () => Promise.resolve(),
      state: "suspended",
    };
    engine.ctx = ctx as never;
    try {
      await engine.unlock();
      expect(engine.status).toBe("locked");
      expect(pill.hidden).toBe(false);
      ctx.resume = () => {
        ctx.state = "running";
        return Promise.resolve();
      };
      document.body.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, button: 0 })
      );
      expect(await until(() => pill.hidden === true)).toBe(true);
      expect(engine.status).toBe("running");
    } finally {
      engine.ctx = null;
    }
  });
});

vi.setConfig({ testTimeout: 15_000 });

describe("starter content", () => {
  it("normalizes with zero issues", async () => {
    const {
      normalizeInstrument,
      normalizeProject,
      normalizeSfx,
      normalizeSong,
    } = await import("../src/lib/core.ts");
    const bad: string[] = [];
    for (const [path, doc] of starterFiles()) {
      let res: { issues: readonly { message: string; path: string }[] } =
        normalizeProject(doc);
      if (path.startsWith("sfx/")) {
        res = normalizeSfx(doc);
      } else if (path.startsWith("songs/")) {
        res = normalizeSong(doc);
      } else if (path.startsWith("instruments/")) {
        res = normalizeInstrument(doc);
      }
      for (const i of res.issues) {
        bad.push(`${path} ${i.path} ${i.message}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("issue field labels", () => {
  it("translates JSON pointers into the inspector's field names", () => {
    expect(fieldLabel("/loop")).toBe("Loop to order");
    expect(fieldLabel("/frequency/start")).toBe("Frequency / Start (Hz)");
    expect(fieldLabel("/bitcrush/rateDivide")).toBe("Crush / Rate divide");
    expect(fieldLabel("/channels/2/mml")).toBe("Channel 3 / MML");
    expect(fieldLabel("/fm/ops/1/sustainLevel")).toBe(
      "FM patch / Operator 2 / Sustain level"
    );
    expect(fieldLabel("/patterns/verse/tracks/noise/4/note")).toBe(
      "Pattern verse / noise / Row 4 / Note"
    );
    expect(fieldLabel("/master/echo")).toBe("Master / Echo");
    expect(fieldLabel("")).toBe("Whole document");
  });

  it("falls back to plain words for paths it does not know", () => {
    expect(fieldLabel("/someNewField")).toBe("Some new field");
    expect(fieldLabel("/envelope/newThing")).toBe("Envelope / New thing");
    expect(fieldLabel("/arpeggio/steps/3")).toBe("Arpeggio / Steps / Item 4");
  });

  it("still reads legacy dotted paths", () => {
    expect(fieldLabel("frequency.start")).toBe("Frequency / Start (Hz)");
  });

  it("never prints a raw pointer in the issues box", () => {
    const box = issuesBox([
      {
        message: "MML loop point L overrides loop 1",
        path: "/loop",
        severity: "warning",
      },
    ]);
    expect(box?.textContent).toContain("Loop to order");
    expect(box?.textContent).not.toContain("/loop");
  });
});
