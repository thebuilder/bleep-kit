import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

describe("bleepkit", () => {
  it("runs from the workspace sources with Node's type stripping", () => {
    const out = execFileSync(process.execPath, [ENTRY], { encoding: "utf8" });
    expect(out).toContain("bleepkit");
  });
});
