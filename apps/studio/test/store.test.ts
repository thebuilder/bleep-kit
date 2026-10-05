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

  it("reads files back as bytes, text as UTF-8 and a missing file as null", async () => {
    const { store } = await put("a.json", sfx);
    const text = await store.readBytes("sfx/a.json");
    expect(new TextDecoder().decode(text as Uint8Array)).toContain("envelope");
    await store.writeBytes("out/a.wav", new Uint8Array([1, 2, 3]));
    expect(Array.from((await store.readBytes("out/a.wav")) ?? [])).toEqual([
      1, 2, 3,
    ]);
    expect(await store.readBytes("sfx/none.json")).toBeNull();
  });

  it("starts over with the starter kit", async () => {
    const { store } = await put("mine.json", sfx);
    await store.resetToStarter();
    const paths = (await store.list()).map((f) => f.path);
    expect(paths).not.toContain("sfx/mine.json");
    expect(paths).toContain("project.json");
  });
});

describe("probeServer", () => {
  it("answers with the health body when a studio server is there", async () => {
    vi.stubGlobal("fetch", async () => json({ ok: true, root: "/game" }));
    expect(await probeServer("http://x")).toEqual({ ok: true, root: "/game" });
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
  const route = (table: Record<string, () => Response>) =>
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      const handler =
        table[
          `${init?.method ?? "GET"} ${String(url).replace("http://srv", "")}`
        ];
      return handler
        ? Promise.resolve(handler())
        : Promise.reject(
            new Error(`unexpected ${init?.method ?? "GET"} ${url}`)
          );
    });

  it("opens, lists, reads, removes and exports through the HTTP api", async () => {
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
      "POST /api/export": () => json({ files: ["x"] }),
    });
    const store = new ServerStore("http://srv");
    expect((await store.open()).root).toBe("/game");
    expect(store.label).toBe("/game");
    expect(await store.list()).toEqual(info.files);
    expect((await store.readJson("sfx/a.json")).json).toEqual({ a: 1 });
    await expect(store.readJson("sfx/none.json")).rejects.toThrow("404");
    expect(await store.readBytes("sfx/none.json")).toBeNull();
    await store.remove("sfx/a.json");
    expect(await store.exportAll(false)).toEqual({ files: ["x"] });
    await store.writeBytes();
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
