import { describe, expect, it } from "vitest";

describe("@bleepkit/sfx", () => {
  it("loads its entry point", async () => {
    expect(await import("../src/index.ts")).toBeDefined();
  });
});
