import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { SOFTWARE, VERSION } from "../src/version.ts";

describe("version", () => {
  it("equals the version in package.json", () => {
    const pkg = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    expect(SOFTWARE).toBe(`bleepkit ${pkg.version}`);
  });
});
