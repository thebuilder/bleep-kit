import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.ts";
import { run, tempDir } from "./helpers.ts";

// src/version.ts is a hand maintained literal (the published CLI is one esbuild bundle with no package.json beside
// it), so nothing but this test notices when a release bumps package.json and forgets the literal.
const pkg = JSON.parse(
  fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
) as { version: string };

describe("version", () => {
  it("is the version in package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("`bleepkit --version` prints it", async () => {
    const r = await run(tempDir(), ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(`bleepkit ${pkg.version}`);
  });
});
