// What a render depends on beyond the document: core's ENGINE_VERSION (the sound itself) goes into the render hash, and
// the CLI names itself in the WAV files it writes.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeProject, run } from "./helpers.ts";

const engine = vi.hoisted(() => ({ override: "" }));

vi.mock("@bleepkit/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@bleepkit/core")>();
  return {
    ...real,
    get ENGINE_VERSION() {
      return engine.override || real.ENGINE_VERSION;
    },
  };
});

describe("ENGINE_VERSION in the render hash", () => {
  it("a bumped engine version makes an up to date render stale", async () => {
    const { repo } = await makeProject();
    const first = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(first.json.renders[0].cached).toBe(false);
    const again = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(again.json.renders[0].cached).toBe(true);
    engine.override = "bumped-by-test";
    try {
      const stale = await run(repo, ["list", "--json"]);
      expect(JSON.stringify(stale.json)).toContain("stale");
      const after = await run(repo, ["render", "sfx/coin", "--json"]);
      expect(after.json.renders[0].cached).toBe(false);
    } finally {
      engine.override = "";
    }
  });
});

describe("WAV files written by the CLI", () => {
  it("name the CLI and its version in the LIST INFO chunk", async () => {
    const { project, repo } = await makeProject();
    const r = await run(repo, ["render", "sfx/coin", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const bytes = fs.readFileSync(path.join(project, "out", "sfx", "coin.wav"));
    const text = bytes.toString("latin1");
    expect(text).toContain("ISFT");
    expect(text).toContain("bleepkit 0.1.0");
    expect(text).toContain("ICMT");
  });
});
