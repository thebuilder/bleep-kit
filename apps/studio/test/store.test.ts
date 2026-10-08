/* The two stores behind the studio: the browser's own (documents dropped in by shape) and the CLI server's (HTTP
   answers read as write results, a socket that tells the studio about outside edits), with fetch and WebSocket faked. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalStore, memoryBackend } from "../src/store/local.ts";
import { probeServer, ServerStore } from "../src/store/server.ts";
import type { ServerMessage } from "../src/store/store.ts";

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LocalStore documents", () => {
  const sfx = { envelope: {}, frequency: {} };
  const put = async (name: string, body: unknown) => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    return {
      path: await store.importDocument(name, JSON.stringify(body)),
      store,
    };
  };

  it("files a dropped document by its shape", async () => {
    expect((await put("Big Boom!.json", sfx)).path).toBe("sfx/big-boom.json");
    expect((await put("lead.json", { kind: "fm", macros: {} })).path).toBe(
      "instruments/lead.json"
    );
    expect((await put("theme.json", { patterns: [] })).path).toBe(
      "songs/theme.json"
    );
    expect((await put("order.json", { order: [] })).path).toBe(
      "songs/order.json"
    );
    expect((await put("x.json", { chip: "nes", export: {} })).path).toBe(
      "project.json"
    );
  });

  it("names a document with nothing usable in its file name 'imported'", async () => {
    expect((await put("!!!.json", sfx)).path).toBe("sfx/imported.json");
  });

  it("refuses text that is not JSON, not an object or not a Bleepkit document", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    expect(await store.importDocument("a.json", "{nope")).toBeNull();
    expect(await store.importDocument("a.json", "null")).toBeNull();
    expect(await store.importDocument("a.json", "7")).toBeNull();
    expect(await store.importDocument("a.json", "{}")).toBeNull();
  });

  it("stores documents as pretty JSON with a trailing newline, as the CLI writes them", async () => {
    const { store } = await put("a.json", sfx);
    const text = new TextDecoder().decode(
      (await store.readBytes("sfx/a.json")) as Uint8Array
    );
    expect(text).toBe(`${JSON.stringify(sfx, null, 2)}\n`);
    expect((await store.readJson("sfx/a.json")).json).toEqual(sfx);
  });

  it("reads binary files back as they were written, and a missing file as null or an error", async () => {
    const { store } = await put("a.json", sfx);
    await store.writeBytes("out/a.wav", new Uint8Array([1, 2, 3]));
    expect(Array.from((await store.readBytes("out/a.wav")) ?? [])).toEqual([
      1, 2, 3,
    ]);
    expect(await store.readBytes("sfx/none.json")).toBeNull();
    await expect(store.readJson("sfx/none.json")).rejects.toThrow(
      "No such file"
    );
  });

  it("starts over with the starter kit", async () => {
    const { store } = await put("mine.json", sfx);
    await store.resetToStarter();
    const paths = (await store.list()).map((f) => f.path);
    expect(paths).not.toContain("sfx/mine.json");
    expect(paths).toContain("project.json");
    expect(paths).toContain("sfx/coin.json");
  });
});

describe("LocalStore clean project and folder import", () => {
  it("makes a project of only project.json with the name and chip", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    await store.resetToEmpty("  Space Blaster ", "gameboy");
    expect((await store.list()).map((f) => f.path)).toEqual(["project.json"]);
    const { project } = await store.open();
    expect(project.name).toBe("Space Blaster");
    expect(project.chip).toBe("gameboy");
    expect(store.seeded).toBe(false);
  });

  it("says when it filled a new store with the starter kit", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    expect(store.seeded).toBe(true);
    await store.open();
    expect(store.seeded).toBe(false);
  });

  it("files the documents of a picked folder by their path, whatever the folder is called", async () => {
    const store = new LocalStore(memoryBackend());
    await store.open();
    await store.resetToEmpty("x", "nes");
    const doc = JSON.stringify({ envelope: {}, frequency: {} });
    expect(await store.importEntry("my-game/sfx/boom.json", doc)).toBe(true);
    expect(await store.importEntry("loose.json", doc)).toBe(true);
    expect(
      await store.importEntry("my-game/package.json", '{"name":"x"}')
    ).toBe(false);
    expect(await store.importEntry("my-game/sfx/bad.json", "not json")).toBe(
      false
    );
    expect((await store.list()).map((f) => f.path).sort()).toEqual([
      "project.json",
      "sfx/boom.json",
      "sfx/loose.json",
    ]);
  });
});

describe("probeServer", () => {
  it("answers with the health body when a studio server is there", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      return Promise.resolve(json({ ok: true, root: "/game" }));
    });
    expect(await probeServer("http://x")).toEqual({ ok: true, root: "/game" });
    expect(fetched).toEqual(["http://x/api/health"]);
  });

  it("says no to an error status, a page that is not JSON, a body that is not ok, and a network failure", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    expect(await probeServer()).toBeNull();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("<html>", { headers: { "content-type": "text/html" } })
    );
    expect(await probeServer()).toBeNull();
    vi.stubGlobal("fetch", async () => json({ ok: false }));
    expect(await probeServer()).toBeNull();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(await probeServer()).toBeNull();
  });
});

class FakeSocket {
  static all: FakeSocket[] = [];
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onopen: (() => void) | null = null;
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  close() {
    this.closed = true;
  }
}

describe("ServerStore", () => {
  interface Call {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
  }
  let calls: Call[] = [];
  const route = (table: Record<string, () => Response>) => {
    calls = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        headers: (init?.headers ?? {}) as Record<string, string>,
        method,
        url: String(url),
      });
      const handler =
        table[`${method} ${String(url).replace("http://srv", "")}`];
      return handler
        ? Promise.resolve(handler())
        : Promise.reject(new Error(`unexpected ${method} ${url}`));
    });
  };

  it("opens, lists, reads and removes through the HTTP api", async () => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    const info = {
      files: [{ path: "sfx/a.json" }],
      project: { name: "p" },
      root: "/game",
    };
    route({
      "DELETE /api/file?path=sfx%2Fa.json": () => json({}),
      "GET /api/file?path=sfx%2Fa.json": () => json({ json: { a: 1 } }),
      "GET /api/file?path=sfx%2Fnone.json": () =>
        new Response("", { status: 404 }),
      "GET /api/project": () => json(info),
    });
    const store = new ServerStore("http://srv");
    expect((await store.open()).root).toBe("/game");
    expect(store.label).toBe("/game");
    expect(await store.list()).toEqual(info.files);
    expect((await store.readJson("sfx/a.json")).json).toEqual({ a: 1 });
    await expect(store.readJson("sfx/none.json")).rejects.toThrow("404");
    expect(await store.readBytes("sfx/none.json")).toBeNull();
    await store.remove("sfx/a.json");
    // the delete has to reach the server: a studio that only forgets the file brings it back on the next reload
    expect(calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "http://srv/api/file?path=sfx%2Fa.json",
    });
  });

  it("asks the server to run the export, and says whether it is a dry run", async () => {
    route({ "POST /api/export": () => json({ files: ["x"] }) });
    const store = new ServerStore("http://srv");
    expect(await store.exportAll(false)).toEqual({ files: ["x"] });
    expect(calls.at(-1)?.body).toEqual({ dryRun: false });
    await store.exportAll(true);
    expect(calls.at(-1)?.body).toEqual({ dryRun: true });
  });

  it("sends a save with the etag the document was loaded at, and without one to overwrite", async () => {
    const store = new ServerStore("http://srv");
    route({ "PUT /api/file?path=sfx%2Fa.json": () => json({ etag: "e2" }) });
    await store.writeJson("sfx/a.json", { v: 1 }, "e1");
    expect(calls.at(-1)).toMatchObject({
      body: { ifMatch: "e1", json: { v: 1 } },
      method: "PUT",
      url: "http://srv/api/file?path=sfx%2Fa.json",
    });
    expect(calls.at(-1)?.headers["content-type"]).toBe("application/json");
    await store.writeJson("sfx/a.json", { v: 2 });
    // "Keep mine": no ifMatch key at all, or the server would refuse the overwrite
    expect(calls.at(-1)?.body).toEqual({ json: { v: 2 } });
  });

  it("reads the server's answers to a write", async () => {
    const store = new ServerStore("http://srv");
    const put = (res: () => Response) => {
      route({ "PUT /api/file?path=sfx%2Fa.json": res });
      return store.writeJson("sfx/a.json", { v: 1 }, "e1");
    };
    expect(await put(() => json({ etag: "e2", mtime: 5 }))).toEqual({
      etag: "e2",
      mtime: 5,
      ok: true,
    });
    expect(
      await put(() => json({ etag: "e9", json: { v: 0 } }, { status: 412 }))
    ).toEqual({
      etag: "e9",
      json: { v: 0 },
      ok: false,
      reason: "conflict",
    });
    expect(
      await put(() => json({ issues: [{ path: "/a" }] }, { status: 422 }))
    ).toMatchObject({
      issues: [{ path: "/a" }],
      reason: "invalid",
    });
    expect(
      await put(() => json({ error: "disk full" }, { status: 500 }))
    ).toMatchObject({
      message: "disk full",
      reason: "error",
    });
    expect(
      await put(() => new Response("not json", { status: 502 }))
    ).toMatchObject({ message: "502", reason: "error" });
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(await store.writeJson("sfx/a.json", {})).toMatchObject({
      message: "offline",
      reason: "error",
    });
  });

  it("refuses to open when the server answers badly", async () => {
    route({ "GET /api/project": () => new Response("", { status: 503 }) });
    await expect(new ServerStore("http://srv").open()).rejects.toThrow("503");
  });

  it("passes the socket's messages on, ignores junk, and reconnects after it drops", async () => {
    vi.useFakeTimers();
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
    route({
      "GET /api/project": () => json({ files: [], project: {}, root: "r" }),
    });
    const store = new ServerStore("http://srv");
    const seen: ServerMessage[] = [];
    const off = store.subscribe((m) => seen.push(m));
    await store.open();
    const [first] = FakeSocket.all as [FakeSocket];
    expect(first.url).toBe("ws://srv/ws");
    first.onopen?.();
    first.onmessage?.({
      data: JSON.stringify({ path: "sfx/a.json", type: "deleted" }),
    });
    first.onmessage?.({ data: "{broken" });
    expect(seen).toEqual([{ path: "sfx/a.json", type: "deleted" }]);
    first.onclose?.();
    vi.advanceTimersByTime(600);
    expect(FakeSocket.all.length).toBe(2);
    off();
    store.close();
    expect(FakeSocket.all[1]?.closed).toBe(true);
    FakeSocket.all[1]?.onclose?.();
    vi.advanceTimersByTime(10_000);
    expect(FakeSocket.all.length).toBe(2);
  });

  it("works without a WebSocket", async () => {
    vi.stubGlobal("WebSocket", undefined);
    route({
      "GET /api/project": () => json({ files: [], project: {}, root: "r" }),
    });
    expect((await new ServerStore("http://srv").open()).root).toBe("r");
  });
});
