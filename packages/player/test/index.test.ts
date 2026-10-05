import { describe, expect, it } from "vitest";

describe("@bleepkit/player", () => {
  it("loads its entry point", async () => {
    expect(await import("../src/index.ts")).toBeDefined();
  });
});
