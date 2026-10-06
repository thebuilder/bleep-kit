// `bleepkit play` talks to a studio over HTTP. These tests stand in for the studio with a tiny server, so every
// answer play has to handle (a tab played, no tab, a refusal, a body that is not JSON, nobody home) is exercised.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeProject, run, tempDir } from "./helpers.ts";

const servers: http.Server[] = [];

interface Seen {
  body?: unknown;
  contentType?: string | undefined;
  method?: string | undefined;
  requests: number;
  url?: string | undefined;
}

async function fakeStudio(
  status: number,
  body: string,
  seen: Seen = { requests: 0 }
): Promise<string> {
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (d) => {
      text += String(d);
    });
    req.on("end", () => {
      seen.requests += 1;
      seen.method = req.method;
      seen.url = req.url;
      seen.contentType = req.headers["content-type"];
      seen.body = JSON.parse(text || "null");
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve)))
  );
});

describe("play", () => {
  it("needs a reference", async () => {
    const r = await run(tempDir(), ["play", "--json"]);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).toContain("play needs a document reference");
  });

  it("POSTs the resolved ref and the visual flag as JSON to /api/play, and says how many tabs played", async () => {
    const { repo } = await makeProject();
    const seen: Seen = { requests: 0 };
    const url = await fakeStudio(200, '{"ok":true,"clients":2}', seen);
    const r = await run(repo, [
      "play",
      "coin",
      "--studio",
      url,
      "--visual",
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/api/play");
    expect(seen.contentType).toContain("application/json");
    expect(seen.body).toEqual({ ref: "sfx/coin", visual: true });
    expect(r.json).toMatchObject({ clients: 2, ok: true, ref: "sfx/coin" });
    const human = await run(repo, ["play", "sfx/coin", "--studio", url]);
    expect(human.stdout).toContain("Playing sfx/coin in 2 studio tabs");
    expect(seen.body).toEqual({ ref: "sfx/coin", visual: false });
  });

  it("says singular for one tab and explains when no tab is open", async () => {
    const { repo } = await makeProject();
    const one = await fakeStudio(200, '{"ok":true,"clients":1}');
    expect(
      (await run(repo, ["play", "sfx/coin", "--studio", one])).stdout
    ).toContain("in 1 studio tab at");
    const none = await fakeStudio(200, '{"ok":true,"clients":0}');
    expect(
      (await run(repo, ["play", "sfx/coin", "--studio", none])).stdout
    ).toContain("has no browser tab open");
  });

  it("plays a kind/id ref even where there is no project to check it against", async () => {
    const seen: Seen = { requests: 0 };
    const url = await fakeStudio(200, '{"ok":true,"clients":1}', seen);
    const r = await run(tempDir(), [
      "play",
      "sfx/coin",
      "--studio",
      url,
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect(seen.body).toMatchObject({ ref: "sfx/coin" });
  });

  it("refuses a bare id when there is no project, and an unknown ref in one, without bothering the studio", async () => {
    const seen: Seen = { requests: 0 };
    const url = await fakeStudio(200, '{"ok":true,"clients":1}', seen);
    expect((await run(tempDir(), ["play", "coin", "--studio", url])).code).toBe(
      3
    );
    const { repo } = await makeProject();
    expect((await run(repo, ["play", "sfx/nope", "--studio", url])).code).toBe(
      4
    );
    expect(seen.requests).toBe(0);
  });

  it("exits 4 with a fix when no studio answers", async () => {
    const { repo } = await makeProject();
    const r = await run(repo, [
      "play",
      "sfx/coin",
      "--studio",
      "http://127.0.0.1:1",
      "--json",
    ]);
    expect(r.code).toBe(4);
    expect(r.json.error.code).toBe("not-found");
    expect(r.json.error.hint).toContain("bleepkit studio");
  });

  it("reports a studio that refuses, and one that is not a studio at all", async () => {
    const { repo } = await makeProject();
    const refusing = await fakeStudio(
      404,
      '{"error":"not-found","message":"no such document"}'
    );
    const refused = await run(repo, ["play", "sfx/coin", "--studio", refusing]);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain(
      "refused the request (404): no such document"
    );
    const odd = await fakeStudio(200, "<html>hello</html>");
    const notStudio = await run(repo, ["play", "sfx/coin", "--studio", odd]);
    expect(notStudio.code).toBe(1);
    expect(notStudio.stderr).toContain("unexpected response");
  });
});
