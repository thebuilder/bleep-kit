import { describe, expect, it } from "vitest";

describe("@bleepkit/core", () => {
  it("loads both entry points", async () => {
    expect(await import("../src/index.ts")).toBeDefined();
    expect(await import("../src/tools.ts")).toBeDefined();
  });
});
