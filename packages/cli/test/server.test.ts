import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CliError } from "../src/output.ts";
import { type RunningServer, startServer } from "../src/server/index.ts";
import { classify, cleanRelPath } from "../src/server/paths.ts";
import {
  makeProject,
  readJson,
  readWav,
  run,
  tempDir,
  wavLevels,
  writeJson,
} from "./helpers.ts";

let server: RunningServer;
let base: string;
let project: string;
let dist: string;
let outer: string;

/** A file outside both the project and the studio dist that no request may ever return. */
const SECRET = "bleepkit-test-secret-do-not-serve";

/** architecture.md 6.3: the etag is the sha1 of the file bytes, 12 hex chars. Computed here from the bytes, not with the server's helper. */
function etagOfBytes(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex").slice(0, 12);
}

function etagOfFile(file: string): string {
  return etagOfBytes(fs.readFileSync(file));
}

/** Every file the API may list, found by walking the folder: project.json, sfx|instruments|songs/*.json, out/**. */
function expectedFiles(root: string): string[] {
  const found = ["project.json"];
  for (const dir of ["sfx", "instruments", "songs"]) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (f.endsWith(".json") && !f.startsWith(".")) {
        found.push(`${dir}/${f}`);
      }
    }
  }
  const walk = (rel: string): void => {
    for (const d of fs.readdirSync(path.join(root, rel), {
      withFileTypes: true,
    })) {
      if (d.isDirectory()) {
        walk(`${rel}/${d.name}`);
      } else if (!d.name.startsWith(".")) {
        found.push(`${rel}/${d.name}`);
      }
    }
  };
  walk("out");
  return found.sort();
}

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

/**
 * A websocket client that records every message. `next(type, where)` resolves with the first unread message of that
 * type whose fields equal `where` (the watcher also reports files written by earlier tests, so the file tests name
 * the path they are waiting for).
 */
function connect(): Promise<{
  close: () => void;
  messages: Json[];
  next: (type: string, where?: Json, timeoutMs?: number) => Promise<Json>;
  socket: WebSocket;
}> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const messages: Json[] = [];
    const waiters: {
      accept: (m: Json) => boolean;
      resolve: (m: Json) => void;
    }[] = [];
    socket.on("message", (data) => {
      const m = JSON.parse(String(data)) as Json;
      messages.push(m);
      for (const w of [...waiters]) {
        if (w.accept(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    });
    socket.on("error", reject);
    const handle = {
      close: () => socket.close(),
      messages,
      next: (type: string, where: Json = {}, timeoutMs = 3000) => {
        const accept = (m: Json): boolean =>
          m.type === type &&
          Object.entries(where).every(([k, v]) => m[k] === v);
        const existing = messages.find(accept);
        if (existing) {
          messages.splice(messages.indexOf(existing), 1);
          return Promise.resolve(existing);
        }
        return new Promise<Json>((res, rej) => {
          const t = setTimeout(
            () =>
              rej(
                new Error(
                  `no ${type} message ${JSON.stringify(where)} within ${timeoutMs} ms; got ${JSON.stringify(messages)}`
                )
              ),
            timeoutMs
          );
          waiters.push({
            accept,
            resolve: (m) => {
              clearTimeout(t);
              messages.splice(messages.indexOf(m), 1);
              res(m);
            },
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
  outer = tempDir("bleepkit-dist-outer-");
  fs.writeFileSync(path.join(outer, "secret.txt"), SECRET);
  dist = path.join(outer, "dist");
  fs.mkdirSync(dist);
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
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(res.headers.get("content-type")).toContain("text/html");
    const js = await fetch(`${base}/assets/app.js`);
    expect(js.headers.get("content-type")).toContain("javascript");
    expect(js.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
  });

  it("does not serve files outside dist, however the traversal is spelled", async () => {
    // secret.txt sits next to dist/: one level up from the served folder
    for (const spelling of [
      "/..%2Fsecret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/..%2F..%2Fsecret.txt",
      "/..%2F..%2F..%2F..%2F..%2Fetc%2Fpasswd",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the assertion names the spelling that leaked
      const r = await rawGet(`${base}${spelling}`, {});
      expect([403, 404], spelling).toContain(r.status);
      expect(r.body, spelling).not.toContain(SECRET);
    }
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
    const loopback = await rawGet(`${base}/api/health`, {
      host: `127.0.0.1:${server.port}`,
      origin: "http://127.0.0.1:5173",
    });
    expect(loopback.status).toBe(200);
  });

  it("is not fooled by hosts and origins that merely start with localhost", async () => {
    for (const headers of [
      { origin: "http://localhost.evil.example" },
      { origin: "http://127.0.0.1.evil.example" },
      { origin: "https://evil.example/http://localhost" },
      { origin: "null" },
      { host: "localhost.evil.example" },
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the assertion names the headers that got through
      const r = await rawGet(`${base}/api/health`, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("fails with a bind error (exit code 6) when the port is taken", async () => {
    const failure = await startServer({
      port: server.port,
      root: project,
      studioDist: null,
      version: "x",
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(CliError);
    expect(failure).toMatchObject({ code: "bind", exitCode: 6 });
    expect((failure as CliError).hint).toContain("--port");
  });
});

describe("GET /api/health and /api/project", () => {
  it("reports health", async () => {
    const r = await api("GET", "/api/health");
    expect(r.body).toEqual({ ok: true, root: project, version: "9.9.9" });
  });

  it("lists the project and exactly the files the API may serve, with kind, size and etag", async () => {
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
    expect(files.map((f) => f.path).sort()).toEqual(expectedFiles(project));
    const kindOf = (rel: string): string =>
      ({
        instruments: "instrument",
        out: "render",
        "project.json": "project",
        sfx: "sfx",
        songs: "song",
      })[rel.split("/")[0] as string] as string;
    for (const f of files) {
      const abs = path.join(project, f.path);
      expect(f.kind, f.path).toBe(kindOf(f.path));
      expect(f.size, f.path).toBe(fs.statSync(abs).size);
      expect(f.etag, f.path).toBe(etagOfFile(abs));
    }
  });
});

describe("/api/file", () => {
  it("GET returns the parsed JSON, its etag (sha1 of the bytes) and its mtime", async () => {
    const file = path.join(project, "sfx", "coin.json");
    const r = await api("GET", "/api/file?path=sfx/coin.json");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ path: "sfx/coin.json" });
    expect(r.body.etag).toBe(etagOfFile(file));
    expect(r.body.json).toEqual(readJson(file));
    expect(r.body.mtime).toBe(fs.statSync(file).mtimeMs);
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

  it("does not follow a symlink in out/ to a file outside the project", async () => {
    const link = path.join(project, "out", "leak.txt");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(outer, "secret.txt"), link);
    try {
      const r = await api("GET", "/api/file?path=out/leak.txt");
      expect(r.status).toBe(403);
      expect(JSON.stringify(r.body)).not.toContain(SECRET);
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it("PUT saves the normalized document without leaving temp files, and returns the new etag", async () => {
    const dir = path.join(project, "sfx");
    const get = await api("GET", "/api/file?path=sfx/coin.json");
    const doc = structuredClone(get.body.json);
    doc.volume = 0.31;
    const before = fs.readdirSync(dir).sort();
    const put = await api("PUT", "/api/file?path=sfx/coin.json", {
      ifMatch: get.body.etag,
      json: doc,
    });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);
    const onDisk = path.join(dir, "coin.json");
    expect(put.body.json.volume).toBe(0.31);
    expect(readJson(onDisk)).toEqual(put.body.json);
    expect(put.body.etag).not.toBe(get.body.etag);
    expect(put.body.etag).toBe(etagOfFile(onDisk));
    // temp then rename: nothing but the target is left in the folder
    expect(fs.readdirSync(dir).sort()).toEqual(before);
    const again = await api("GET", "/api/file?path=sfx/coin.json");
    expect(again.body.etag).toBe(put.body.etag);
  });

  it("PUT normalizes first: defaults are filled in, out of range values clamped and reported", async () => {
    const put = await api("PUT", "/api/file?path=sfx/minimal.json", {
      json: {
        category: "coin",
        chip: "nes",
        version: 1,
        volume: 5,
        wave: "square",
      },
    });
    expect(put.status).toBe(200);
    const onDisk = readJson(path.join(project, "sfx", "minimal.json")) as Json;
    expect(onDisk.volume).toBe(1);
    expect(onDisk.envelope).toEqual(
      expect.objectContaining({ decay: expect.any(Number) })
    );
    expect(put.body.issues).toEqual([
      expect.objectContaining({ path: "/volume", severity: "warning" }),
    ]);
    await api("DELETE", "/api/file?path=sfx/minimal.json");
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
    const before = fs.readFileSync(
      path.join(project, "songs", "title.json"),
      "utf8"
    );
    const r = await api("PUT", "/api/file?path=songs/title.json", {
      json: song,
    });
    expect(r.status).toBe(422);
    expect(r.body.issues).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("does-not-exist"),
        path: "/channels/0/instrument",
        severity: "error",
      }),
    ]);
    expect(
      fs.readFileSync(path.join(project, "songs", "title.json"), "utf8")
    ).toBe(before);
  });

  it("PUT validates project.json too and leaves it alone when it has errors", async () => {
    const file = path.join(project, "project.json");
    const before = fs.readFileSync(file, "utf8");
    const current = readJson(file) as Json;
    const r = await api("PUT", "/api/file?path=project.json", {
      json: { ...current, chip: "amiga" },
    });
    expect(r.status).toBe(422);
    expect(r.body.issues).toEqual([
      expect.objectContaining({ path: "/chip", severity: "error" }),
    ]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
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
    expect(
      Buffer.from(bytes).equals(
        fs.readFileSync(path.join(project, "out", "sfx", "coin.wav"))
      )
    ).toBe(true);
    const json = await api("GET", "/api/file?path=out/sfx/coin.meta.json");
    expect(json.body.json.hash).toMatch(/^[0-9a-f]{40}$/);
    ws.close();
  });

  it("serves out/ files by HTTP Range (RFC 9110): closed, open ended and suffix ranges, 416 past the end", async () => {
    await api("POST", "/api/render", { ref: "sfx/coin" });
    const url = `${base}/api/file?path=out/sfx/coin.wav`;
    const whole = fs.readFileSync(path.join(project, "out", "sfx", "coin.wav"));
    const n = whole.length;
    const cases: { header: string; first: number; last: number }[] = [
      { first: 0, header: "bytes=0-15", last: 15 },
      { first: 8, header: "bytes=8-23", last: 23 },
      { first: n - 10, header: `bytes=${n - 10}-`, last: n - 1 },
      { first: n - 8, header: "bytes=-8", last: n - 1 },
      { first: 100, header: `bytes=100-${n + 5000}`, last: n - 1 },
    ];
    for (const c of cases) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the assertion names the range that failed
      const res = await fetch(url, { headers: { range: c.header } });
      expect(res.status, c.header).toBe(206);
      expect(res.headers.get("content-range"), c.header).toBe(
        `bytes ${c.first}-${c.last}/${n}`
      );
      expect(res.headers.get("content-type")).toBe("audio/wav");
      expect(
        Buffer.from(await res.arrayBuffer()).equals(
          whole.subarray(c.first, c.last + 1)
        ),
        c.header
      ).toBe(true);
    }
    const past = await fetch(url, { headers: { range: `bytes=${n}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe(`bytes */${n}`);
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

  it("POST /api/analyze returns the analysis of the render, matching the WAV on disk", async () => {
    const r = await api("POST", "/api/analyze", { ref: "sfx/coin" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      file: "out/sfx/coin.wav",
      ok: true,
      ref: "sfx/coin",
      sampleRate: 48_000,
    });
    const wav = readWav(path.join(project, "out", "sfx", "coin.wav"));
    expect(r.body.frames).toBe(wav.frames);
    expect(r.body.duration).toBeCloseTo(wav.frames / wav.sampleRate, 5);
    expect(r.body.peakDb).toBeCloseTo(wavLevels(wav).peakDb, 1);
    expect(r.body.envelope.length).toBeGreaterThan(0);
    expect(
      (await api("POST", "/api/analyze", { ref: "sfx/nope" })).status
    ).toBe(404);
  });

  it("POST /api/export with dryRun lists what it would write, and a real export then writes exactly that", async () => {
    const publicDir = path.join(project, "..", "public");
    const dry = await api("POST", "/api/export", { dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, ok: true });
    expect(dry.body.written).toEqual(
      expect.arrayContaining([
        "../public/audio/coin.ogg",
        "../src/audio.ts",
        "../public/audio/manifest.json",
      ])
    );
    expect(fs.existsSync(publicDir)).toBe(false);
    const real = await api("POST", "/api/export", {});
    expect(real.status).toBe(200);
    expect(real.body).toMatchObject({ ok: true });
    expect([...real.body.written].sort()).toEqual([...dry.body.written].sort());
    expect(
      fs
        .readFileSync(path.join(publicDir, "audio", "coin.ogg"))
        .subarray(0, 4)
        .toString("latin1")
    ).toBe("OggS");
    expect(fs.existsSync(path.join(project, "..", "src", "audio.ts"))).toBe(
      true
    );
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
    await api("POST", "/api/play", { ref: "sfx/coin" });
    expect(await a.next("play")).toEqual({
      ref: "sfx/coin",
      type: "play",
      visual: false,
    });
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
    const msg = await ws.next("file", { path: "sfx/coin.json" });
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
    expect((await ws.next("file", { path: "sfx/zap.json" })).path).toBe(
      "sfx/zap.json"
    );
    fs.rmSync(fresh);
    expect(await ws.next("deleted", { path: "sfx/zap.json" })).toEqual({
      path: "sfx/zap.json",
      type: "deleted",
    });
    const put = await api("PUT", "/api/file?path=sfx/zap2.json", {
      json: coin,
    });
    const msg = await ws.next("file", { path: "sfx/zap2.json" });
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
    const msg = await ws.next("file", { path: "instruments/lead.json" });
    expect(msg.json.name).toBe("burst 4");
    await new Promise((r) => setTimeout(r, 250));
    // one message for the five writes, and none for the temp file
    expect(
      ws.messages.filter((m) => m.path === "instruments/lead.json")
    ).toHaveLength(0);
    expect(
      ws.messages.some((m) => String(m.path ?? "").includes("scratch"))
    ).toBe(false);
    fs.rmSync(path.join(project, "sfx", ".scratch.tmp"));
    ws.close();
  });

  it("accepts websocket upgrades from localhost pages and refuses every other origin", async () => {
    const attempt = (origin: string) =>
      new Promise<string>((resolve) => {
        const socket = new WebSocket(`${base.replace("http", "ws")}/ws`, {
          headers: { origin },
        });
        socket.on("open", () => {
          socket.close();
          resolve("open");
        });
        socket.on("error", () => resolve("refused"));
        socket.on("unexpected-response", () => resolve("refused"));
      });
    // the Vite dev server (pnpm dev) is a localhost page that proxies /ws
    expect(await attempt("http://localhost:5173")).toBe("open");
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "null",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, the assertion names the origin that got in
      expect(await attempt(origin), origin).toBe("refused");
    }
  });
});
