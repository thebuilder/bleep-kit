import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CliError } from "../src/output.ts";
import { type RunningServer, startServer } from "../src/server/index.ts";
import { classify, cleanRelPath } from "../src/server/paths.ts";
import { makeProject, readJson, run, tempDir, writeJson } from "./helpers.ts";

let server: RunningServer;
let base: string;
let project: string;
let dist: string;

interface Json {
  [key: string]: any;
}

async function api(
  method: string,
  route: string,
  body?: unknown
): Promise<{ body: Json; headers: Headers; status: number }> {
  const res = await fetch(`${base}${route}`, {
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }),
    method,
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { text };
  }
  return { body: parsed, headers: res.headers, status: res.status };
}

function connect(): Promise<{
  close: () => void;
  messages: Json[];
  next: (type: string, timeoutMs?: number) => Promise<Json>;
  socket: WebSocket;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: Json[] = [];
    const waiters: { resolve: (m: Json) => void; type: string }[] = [];
    socket.on("message", (data) => {
      const m = JSON.parse(String(data)) as Json;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.type === m.type) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    socket.on("error", reject);
    const handle = {
      close: () => socket.close(),
      messages,
      next: (type: string, timeoutMs = 3000) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) {
          messages.splice(messages.indexOf(existing), 1);
          return Promise.resolve(existing);
        }
        return new Promise<Json>((res, rej) => {
          const t = setTimeout(
            () =>
              rej(
                new Error(
                  `no ${type} message within ${timeoutMs} ms; got ${JSON.stringify(messages)}`
                )
              ),
            timeoutMs
          );
          waiters.push({
            resolve: (m) => {
              clearTimeout(t);
              messages.splice(messages.indexOf(m), 1);
              res(m);
            },
            type,
          });
        });
      },
      socket,
    };
    socket.on("open", () => resolve(handle));
  });
}

function rawGet(
  url: string,
  headers: Record<string, string>
): Promise<{ body: string; status: number }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        headers,
        host: u.hostname,
        method: "GET",
        path: u.pathname + u.search,
        port: u.port,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ body, status: res.statusCode ?? 0 }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const made = await makeProject();
  ({ project } = made);
  await run(made.repo, [
    "new",
    "song",
    "title",
    "--mml",
    "pulse1=o4 l8 cdefgab>c",
  ]);
  dist = tempDir("bleepkit-dist-");
  fs.writeFileSync(
    path.join(dist, "index.html"),
    "<!doctype html><title>studio</title>"
  );
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "export {};");
  server = await startServer({
    port: 0,
    root: project,
    studioDist: dist,
    version: "9.9.9",
  });
  base = server.url;
});

afterAll(async () => {
  await server.close();
});

describe("paths", () => {
  it("accepts only project.json, documents and out/**", () => {
    expect(classify("project.json")?.kind).toBe("project");
    expect(classify("sfx/coin.json")).toMatchObject({
      docKind: "sfx",
      id: "coin",
      kind: "sfx",
    });
    expect(classify("songs/title.json")?.kind).toBe("song");
    expect(classify("instruments/lead.json")?.kind).toBe("instrument");
    expect(classify("out/sfx/coin.wav")?.kind).toBe("render");
    for (const bad of [
      "package.json",
      "src/audio.ts",
      "sfx/Coin.json",
      "sfx/a/b.json",
      "sfx/coin.txt",
      "out",
      "notes.md",
    ]) {
      expect(classify(bad), bad).toBeNull();
    }
  });

  it("rejects traversal, absolute paths, backslashes and dotfiles", () => {
    for (const bad of [
      "../x.json",
      "sfx/../project.json",
      "/etc/passwd",
      "sfx\\coin.json",
      "sfx/.hidden.json",
      "",
      "a//b",
      "./project.json",
      "out/../../x",
    ]) {
      expect(cleanRelPath(bad), bad).toBeNull();
    }
    expect(cleanRelPath("out/sfx/coin.wav")).toBe("out/sfx/coin.wav");
  });
});

describe("static files and headers", () => {
  it("serves the built studio with COOP, COEP and CORP headers", async () => {
    const res = await api("GET", "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(res.headers.get("cross-origin-embedder-policy")).toBe(
      "require-corp"
    );
    expect(res.headers.get("content-type")).toContain("text/html");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it("does not serve files outside dist", async () => {
    const r = await rawGet(`${base}/..%2F..%2Fetc%2Fpasswd`, {});
    expect([403, 404]).toContain(r.status);
  });

  it("explains how to build the studio when there is no dist", async () => {
    const bare = await startServer({
      port: 0,
      root: project,
      studioDist: null,
      version: "x",
    });
    const res = await fetch(`${bare.url}/`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("pnpm --filter @bleepkit/studio build");
    expect(text).toContain("pnpm dev");
    expect((await fetch(`${bare.url}/api/health`)).status).toBe(200);
    await bare.close();
  });

  it("--api-only answers / with a pointer to the Vite dev server", async () => {
    const only = await startServer({
      apiOnly: true,
      port: 0,
      root: project,
      studioDist: dist,
      version: "x",
    });
    const res = await fetch(`${only.url}/`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { message: string }).message).toContain(
      "pnpm dev"
    );
    await only.close();
  });

  it("refuses other hosts and cross-site origins", async () => {
    const host = await rawGet(`${base}/api/health`, { host: "evil.example" });
    expect(host.status).toBe(403);
    const origin = await rawGet(`${base}/api/health`, {
      origin: "https://evil.example",
    });
    expect(origin.status).toBe(403);
    const local = await rawGet(`${base}/api/health`, {
      origin: "http://localhost:5173",
    });
    expect(local.status).toBe(200);
  });

  it("fails with a bind error when the port is taken", async () => {
    await expect(
      startServer({
        port: server.port,
        root: project,
        studioDist: null,
        version: "x",
      })
    ).rejects.toMatchObject({
      code: "bind",
    });
    await expect(
      startServer({
        port: server.port,
        root: project,
        studioDist: null,
        version: "x",
      })
    ).rejects.toBeInstanceOf(CliError);
  });
});

describe("GET /api/health and /api/project", () => {
  it("reports health", async () => {
    const r = await api("GET", "/api/health");
    expect(r.body).toEqual({ ok: true, root: project, version: "9.9.9" });
  });

  it("lists the project and its files with etags", async () => {
    const r = await api("GET", "/api/project");
    expect(r.status).toBe(200);
    expect(r.body.root).toBe(project);
    expect(r.body.project).toMatchObject({ chip: "nes", version: 1 });
    const files = r.body.files as {
      etag: string;
      kind: string;
      mtime: number;
      path: string;
      size: number;
    }[];
    const paths = files.map((f) => f.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "project.json",
        "sfx/coin.json",
        "instruments/lead.json",
        "songs/title.json",
      ])
    );
    expect(files.find((f) => f.path === "sfx/coin.json")).toMatchObject({
      kind: "sfx",
    });
    for (const f of files) {
      expect(f.etag).toMatch(/^[0-9a-f]{12}$/);
      expect(f.size).toBeGreaterThan(0);
    }
  });
});

describe("/api/file", () => {
  it("GET returns the JSON with an etag and mtime", async () => {
    const r = await api("GET", "/api/file?path=sfx/coin.json");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: "sfx/coin.json" });
    expect(r.body.etag).toMatch(/^[0-9a-f]{12}$/);
    expect(r.body.json.category).toBe("coin");
    expect(typeof r.body.mtime).toBe("number");
  });

  it("403 for anything outside the allowed set and 404 for a missing allowed path", async () => {
    for (const p of [
      "../package.json",
      "src/audio.ts",
      "sfx/..%2Fproject.json",
      "%2Fetc%2Fpasswd",
      "package.json",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the assertion names the path that failed
      const r = await api("GET", `/api/file?path=${p}`);
      expect(r.status, p).toBe(403);
    }
    expect((await api("GET", "/api/file")).status).toBe(403);
    expect((await api("GET", "/api/file?path=sfx/missing.json")).status).toBe(
      404
    );
    expect(
      (await api("PUT", "/api/file?path=src/x.json", { json: {} })).status
    ).toBe(403);
    expect(
      (await api("PUT", "/api/file?path=out/sfx/x.json", { json: {} })).status
    ).toBe(403);
  });

  it("PUT saves atomically, normalizes, and returns the new etag", async () => {
    const get = await api("GET", "/api/file?path=sfx/coin.json");
    const doc = structuredClone(get.body.json);
    doc.volume = 0.31;
    const put = await api("PUT", "/api/file?path=sfx/coin.json", {
      ifMatch: get.body.etag,
      json: doc,
    });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    expect(put.body.etag).not.toBe(get.body.etag);
    expect(put.body.json.volume).toBe(0.31);
    expect(
      (readJson(path.join(project, "sfx", "coin.json")) as { volume: number })
        .volume
    ).toBe(0.31);
    const leftovers = fs
      .readdirSync(path.join(project, "sfx"))
      .filter((f) => f.endsWith(".tmp") || f.startsWith("."));
    expect(leftovers).toEqual([]);
    const again = await api("GET", "/api/file?path=sfx/coin.json");
    expect(again.body.etag).toBe(put.body.etag);
  });

  it("PUT with a stale etag is 412 with the current document", async () => {
    const get = await api("GET", "/api/file?path=sfx/coin.json");
    const stale = "000000000000";
    const doc = structuredClone(get.body.json);
    doc.volume = 0.9;
    const r = await api("PUT", "/api/file?path=sfx/coin.json", {
      ifMatch: stale,
      json: doc,
    });
    expect(r.status).toBe(412);
    expect(r.body).toMatchObject({ error: "conflict", etag: get.body.etag });
    expect(r.body.json.volume).toBe(get.body.json.volume);
    expect(
      (readJson(path.join(project, "sfx", "coin.json")) as { volume: number })
        .volume
    ).toBe(get.body.json.volume);
    // omitting ifMatch overwrites ("keep mine")
    const forced = await api("PUT", "/api/file?path=sfx/coin.json", {
      json: doc,
    });
    expect(forced.status).toBe(200);
    expect(forced.body.json.volume).toBe(0.9);
  });

  it("PUT with ifMatch on a file that does not exist is 412", async () => {
    const r = await api("PUT", "/api/file?path=sfx/ghost.json", {
      ifMatch: "abc",
      json: {},
    });
    expect(r.status).toBe(412);
    expect(r.body.etag).toBeNull();
  });

  it("PUT creates a new document and validates it (422 with issues when not ok)", async () => {
    const coin = (await api("GET", "/api/file?path=sfx/coin.json")).body.json;
    const created = await api("PUT", "/api/file?path=sfx/fresh.json", {
      json: { ...coin, name: "Fresh" },
    });
    expect(created.status).toBe(200);
    expect(fs.existsSync(path.join(project, "sfx", "fresh.json"))).toBe(true);
    const before = fs.readFileSync(
      path.join(project, "sfx", "fresh.json"),
      "utf8"
    );
    const bad = await api("PUT", "/api/file?path=sfx/fresh.json", {
      json: { ...coin, volume: "loud", wave: 12 },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid");
    expect(
      bad.body.issues.some(
        (i: { path: string; severity: string }) =>
          i.path === "/volume" && i.severity === "error"
      )
    ).toBe(true);
    expect(
      fs.readFileSync(path.join(project, "sfx", "fresh.json"), "utf8")
    ).toBe(before);
    const malformed = await api("PUT", "/api/file?path=sfx/fresh.json", {
      notjson: 1,
    });
    expect(malformed.status).toBe(400);
  });

  it("PUT validates songs against the project's instruments", async () => {
    const song = (await api("GET", "/api/file?path=songs/title.json")).body
      .json;
    song.channels[0].instrument = "does-not-exist";
    const r = await api("PUT", "/api/file?path=songs/title.json", {
      json: song,
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.issues)).toContain("does-not-exist");
  });

  it("DELETE removes a document, 404 when missing, 403 for project.json", async () => {
    expect((await api("DELETE", "/api/file?path=sfx/fresh.json")).status).toBe(
      200
    );
    expect(fs.existsSync(path.join(project, "sfx", "fresh.json"))).toBe(false);
    expect((await api("DELETE", "/api/file?path=sfx/fresh.json")).status).toBe(
      404
    );
    expect((await api("DELETE", "/api/file?path=project.json")).status).toBe(
      403
    );
    expect((await api("DELETE", "/api/file?path=src/audio.ts")).status).toBe(
      403
    );
  });
});

describe("render, analyze, export, play", () => {
  it("POST /api/render returns the render entry, broadcasts progress, and out/ files are served with Range", async () => {
    const ws = await connect();
    await ws.next("hello");
    const r = await api("POST", "/api/render", {
      options: { analyze: true },
      ref: "sfx/coin",
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      ok: true,
      path: "out/sfx/coin.wav",
      ref: "sfx/coin",
    });
    expect(r.body.analysis.peakDb).toBeLessThan(0);
    expect((await ws.next("render")).status).toBe("started");
    const done = await ws.next("render");
    expect(done).toMatchObject({ ref: "sfx/coin", status: "done" });
    const full = await fetch(`${base}/api/file?path=out/sfx/coin.wav`);
    expect(full.headers.get("content-type")).toBe("audio/wav");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    const bytes = new Uint8Array(await full.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    const part = await fetch(`${base}/api/file?path=out/sfx/coin.wav`, {
      headers: { range: "bytes=0-15" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(
      `bytes 0-15/${bytes.length}`
    );
    expect((await part.arrayBuffer()).byteLength).toBe(16);
    const json = await api("GET", "/api/file?path=out/sfx/coin.meta.json");
    expect(json.body.json.hash).toMatch(/^[0-9a-f]{40}$/);
    ws.close();
  });

  it("render errors are typed: 404 unknown ref, 422 invalid, 400 missing ref", async () => {
    expect((await api("POST", "/api/render", { ref: "sfx/nope" })).status).toBe(
      404
    );
    expect((await api("POST", "/api/render", {})).status).toBe(400);
    const lead = readJson(path.join(project, "sfx", "coin.json")) as Record<
      string,
      unknown
    >;
    writeJson(path.join(project, "sfx", "broken.json"), {
      ...lead,
      volume: "x",
    });
    const bad = await api("POST", "/api/render", { ref: "sfx/broken" });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe("invalid");
    fs.rmSync(path.join(project, "sfx", "broken.json"));
  });

  it("POST /api/analyze returns the analysis object", async () => {
    const r = await api("POST", "/api/analyze", { ref: "sfx/coin" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, ref: "sfx/coin" });
    expect(r.body).toHaveProperty("peakDb");
    expect(r.body).toHaveProperty("envelope");
  });

  it("POST /api/export with dryRun lists changes without writing", async () => {
    const r = await api("POST", "/api/export", { dryRun: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ dryRun: true, ok: true });
    expect(r.body.written.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(project, "..", "public"))).toBe(false);
  });

  it("POST /api/play broadcasts to every connected studio and reports the count", async () => {
    const none = await api("POST", "/api/play", { ref: "sfx/coin" });
    expect(none.body).toMatchObject({ clients: 0, ok: true });
    const a = await connect();
    const b = await connect();
    await a.next("hello");
    await b.next("hello");
    const r = await api("POST", "/api/play", { ref: "coin", visual: true });
    expect(r.body).toEqual({ clients: 2, ok: true, ref: "sfx/coin" });
    expect(await a.next("play")).toEqual({
      ref: "sfx/coin",
      type: "play",
      visual: true,
    });
    expect(await b.next("play")).toMatchObject({ ref: "sfx/coin" });
    expect((await api("POST", "/api/play", { ref: "sfx/nope" })).status).toBe(
      404
    );
    a.close();
    b.close();
  });

  it("unknown routes are 404 JSON and wrong methods 405", async () => {
    expect((await api("GET", "/api/nope")).status).toBe(404);
    expect((await api("GET", "/api/render")).status).toBe(405);
    expect((await api("PATCH", "/api/file?path=project.json")).status).toBe(
      405
    );
  });
});

describe("websocket", () => {
  it("sends hello with the root and project on connect", async () => {
    const ws = await connect();
    const hello = await ws.next("hello");
    expect(hello.root).toBe(project);
    expect(hello.project.chip).toBe("nes");
    ws.close();
  });

  it("broadcasts a file message when a document changes on disk, with its json and etag", async () => {
    const ws = await connect();
    await ws.next("hello");
    const file = path.join(project, "sfx", "coin.json");
    const doc = readJson(file) as { name: string };
    doc.name = "Changed on disk";
    writeJson(file, doc);
    const msg = await ws.next("file");
    expect(msg.path).toBe("sfx/coin.json");
    expect(msg.json.name).toBe("Changed on disk");
    expect(msg.etag).toMatch(/^[0-9a-f]{12}$/);
    const get = await api("GET", "/api/file?path=sfx/coin.json");
    expect(get.body.etag).toBe(msg.etag);
    ws.close();
  });

  it("broadcasts new files, deletions, and one file message per PUT (no echo from the watcher)", async () => {
    const ws = await connect();
    await ws.next("hello");
    const fresh = path.join(project, "sfx", "zap.json");
    const coin = readJson(path.join(project, "sfx", "coin.json"));
    writeJson(fresh, coin);
    expect((await ws.next("file")).path).toBe("sfx/zap.json");
    fs.rmSync(fresh);
    expect(await ws.next("deleted")).toEqual({
      path: "sfx/zap.json",
      type: "deleted",
    });
    const put = await api("PUT", "/api/file?path=sfx/zap2.json", {
      json: coin,
    });
    const msg = await ws.next("file");
    expect(msg).toMatchObject({ etag: put.body.etag, path: "sfx/zap2.json" });
    await new Promise((r) => setTimeout(r, 250));
    expect(
      ws.messages.filter((m) => m.type === "file" && m.path === "sfx/zap2.json")
    ).toHaveLength(0);
    await api("DELETE", "/api/file?path=sfx/zap2.json");
    ws.close();
  });

  it("debounces a burst of writes into one message and ignores temp files", async () => {
    const ws = await connect();
    await ws.next("hello");
    const file = path.join(project, "instruments", "lead.json");
    const doc = readJson(file) as { name: string };
    for (let i = 0; i < 5; i += 1) {
      writeJson(file, { ...doc, name: `burst ${i}` });
    }
    fs.writeFileSync(path.join(project, "sfx", ".scratch.tmp"), "x");
    const msg = await ws.next("file");
    expect(msg.path).toBe("instruments/lead.json");
    expect(msg.json.name).toBe("burst 4");
    await new Promise((r) => setTimeout(r, 250));
    expect(ws.messages.filter((m) => m.type === "file")).toHaveLength(0);
    fs.rmSync(path.join(project, "sfx", ".scratch.tmp"));
    ws.close();
  });

  it("refuses websocket upgrades from other origins", async () => {
    const result = await new Promise<string>((resolve) => {
      const socket = new WebSocket(`${base.replace("http", "ws")}/ws`, {
        headers: { origin: "https://evil.example" },
      });
      socket.on("open", () => resolve("open"));
      socket.on("error", () => resolve("refused"));
      socket.on("unexpected-response", () => resolve("refused"));
    });
    expect(result).toBe("refused");
  });
});
