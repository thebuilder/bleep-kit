// What a render depends on beyond the document: core's ENGINE_VERSION (the sound itself) goes into the render hash
// (architecture.md 6.2: bumping it makes every render in every project stale), and the CLI names itself in the WAV
// files it writes (section 8: `ISFT: bleepkit <version>`, `ICMT: <id>`).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeProject, readWav, run, runWith } from "./helpers.ts";

const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

describe("ENGINE_VERSION in the render hash", () => {
  it("a bumped engine version makes an up to date render stale in `list` and redone by `render`", async () => {
    // The one thing that has to be faked: ENGINE_VERSION is a constant of core, and the test needs it to "change".
    // The CLI is imported again under the fake (the files of this package share their workers), and the fake is
    // taken away after.
    const engine = { override: "" };
    vi.resetModules();
    vi.doMock("@bleepkit/core", async (importOriginal) => {
      const real = await importOriginal<typeof import("@bleepkit/core")>();
      return {
        ...real,
        get ENGINE_VERSION() {
          return engine.override || real.ENGINE_VERSION;
        },
      };
    });
    try {
      const { main } = await import("../src/cli.ts");
      const cli = (cwd: string, args: string[]) => runWith(main, cwd, args);
      const { repo } = await makeProject();
      const first = await cli(repo, ["render", "sfx/coin", "--json"]);
      expect(first.json.renders[0].cached).toBe(false);
      const again = await cli(repo, ["render", "sfx/coin", "--json"]);
      expect(again.json.renders[0].cached).toBe(true);
      const fresh = await cli(repo, ["list", "sfx", "--json"]);
      expect(fresh.json.sfx[0].render.stale).toBe(false);

      engine.override = "bumped-by-test";
      const stale = await cli(repo, ["list", "sfx", "--json"]);
      expect(stale.json.sfx[0].render.stale).toBe(true);
      const after = await cli(repo, ["render", "sfx/coin", "--json"]);
      expect(after.json.renders[0].cached).toBe(false);
      const settled = await cli(repo, ["render", "sfx/coin", "--json"]);
      expect(settled.json.renders[0].cached).toBe(true);
    } finally {
      vi.doUnmock("@bleepkit/core");
      vi.resetModules();
    }
  });
});

describe("WAV files written by the CLI", () => {
  it("name the CLI version (ISFT) and the document id (ICMT) in the LIST INFO chunk", async () => {
    const { project, repo } = await makeProject();
    await run(repo, ["new", "song", "title", "--mml", "pulse1=o4 l8 cdef"]);
    const r = await run(repo, ["render", "sfx/coin", "song/title", "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const coin = readWav(path.join(project, "out", "sfx", "coin.wav"));
    expect(coin.info).toEqual({
      ICMT: "coin",
      ISFT: `bleepkit ${pkg.version}`,
    });
    const title = readWav(path.join(project, "out", "songs", "title.wav"));
    expect(title.info).toEqual({
      ICMT: "title",
      ISFT: `bleepkit ${pkg.version}`,
    });
  });
});
