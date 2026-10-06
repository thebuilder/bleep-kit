import { SFX_CATEGORIES as CORE_CATEGORIES } from "@bleepkit/core";
import { describe, expect, it } from "vitest";
import * as sfx from "../src/index.ts";

// Section 1.3 is the contract of the package entry point: games, the CLI and the studio import exactly these names.
describe("@bleepkit/sfx entry point", () => {
  it("exports the documented API and nothing else at runtime", () => {
    expect(Object.keys(sfx).sort()).toEqual([
      "SFX_CATEGORIES",
      "categoryRanges",
      "describeSfx",
      "generateSfx",
      "mutateMany",
      "mutateSfx",
      "randomizeSfx",
    ]);
    expect(typeof sfx.categoryRanges).toBe("function");
    expect(typeof sfx.describeSfx).toBe("function");
    expect(typeof sfx.generateSfx).toBe("function");
    expect(typeof sfx.mutateMany).toBe("function");
    expect(typeof sfx.mutateSfx).toBe("function");
    expect(typeof sfx.randomizeSfx).toBe("function");
  });

  it("re-exports the category list of the core types", () => {
    expect(sfx.SFX_CATEGORIES).toBe(CORE_CATEGORIES);
  });
});
