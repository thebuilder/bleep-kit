/* The studio server answers /api/freesound/* with the studio's own handler: "not configured" without the API key,
   configured with it (from the environment or a .env.local next to the built studio), and no key in any answer. No
   network: only the routes that do not reach freesound.org are used. */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server/index.ts";
import { makeProject, tempDir } from "./helpers.ts";

const KEY = "FREESOUND_CLIENT_SECRET";
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) {
    delete process.env[KEY];
  } else {
    process.env[KEY] = saved;
  }
});

async function serve(dist: string | null) {
  const { project } = await makeProject();
  return startServer({
    port: 0,
    root: project,
    studioDist: dist,
    version: "t",
  });
}

describe("freesound routes of the studio server", () => {
  it("says not configured without the key", async () => {
    delete process.env[KEY];
    const server = await serve(null);
    const status = await fetch(`${server.url}/api/freesound/status`);
    expect(await status.json()).toEqual({ configured: false });
    const search = await fetch(`${server.url}/api/freesound/search`);
    expect(search.status).toBe(503);
    expect(((await search.json()) as { error: string }).error).toBe(
      "not-configured"
    );
    await server.close();
  });

  it("is configured by the environment, and the key never appears in an answer", async () => {
    process.env[KEY] = "secret-value-123";
    const server = await serve(null);
    const status = await fetch(`${server.url}/api/freesound/status`);
    expect(await status.text()).not.toContain("secret-value-123");
    expect(
      await (await fetch(`${server.url}/api/freesound/status`)).json()
    ).toEqual({ configured: true });
    const bad = await fetch(`${server.url}/api/freesound/search?sub=nope`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("secret-value-123");
    expect(bad.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    await server.close();
  });

  it("reads .env.local next to the built studio", async () => {
    delete process.env[KEY];
    const app = tempDir();
    const dist = path.join(app, "dist");
    fs.mkdirSync(dist);
    fs.writeFileSync(path.join(dist, "index.html"), "<html></html>");
    fs.writeFileSync(path.join(app, ".env.local"), `${KEY}="from-file"\n`);
    const server = await serve(dist);
    expect(
      await (await fetch(`${server.url}/api/freesound/status`)).json()
    ).toEqual({ configured: true });
    await server.close();
  });

  it("still only answers localhost pages", async () => {
    const server = await serve(null);
    const res = await fetch(`${server.url}/api/freesound/status`, {
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    await server.close();
  });
});
