// `bleepkit play` talks to a studio over HTTP. These tests stand in for the studio with a tiny server, so every
// answer play has to handle (a tab played, no tab, a refusal, a body that is not JSON, nobody home) is exercised.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { makeProject, run, tempDir } from "./helpers.ts";

const servers: http.Server[] = [];

async function fakeStudio(
  status: number,
  body: string,
  seen: { body?: unknown } = {}
): Promise<string> {
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (d) => {
      text += String(d);
    });
    req.on("end", () => {
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

  it("sends the resolved ref and the visual flag, and says how many tabs played", async () => {
    const { repo } = await makeProject();
    const seen: { body?: unknown } = {};
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
    expect(seen.body).toEqual({ ref: "sfx/coin", visual: true });
    expect(r.json).toMatchObject({ clients: 2, ok: true, ref: "sfx/coin" });
    const human = await run(repo, ["play", "sfx/coin", "--studio", url]);
    expect(human.stdout).toContain("Playing sfx/coin in 2 studio tabs");
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
    const seen: { body?: unknown } = {};
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

  it("refuses a bare id when there is no project, and an unknown ref in one", async () => {
    expect((await run(tempDir(), ["play", "coin"])).code).toBe(3);
    const { repo } = await makeProject();
    expect((await run(repo, ["play", "sfx/nope"])).code).toBe(4);
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
