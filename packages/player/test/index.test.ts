import { describe, expect, it } from "vitest";
import * as player from "../src/index.ts";

// Section 1.4 is the contract of the package entry point: games import these names. The types vanish at runtime
// (types.test.ts covers those), so what is left to pin is the runtime surface.
describe("@bleepkit/player entry point", () => {
  it("exports the documented functions and nothing else at runtime", () => {
    expect(Object.keys(player).sort()).toEqual([
      "createEngineNode",
      "createPlayer",
      "loadManifest",
      "supportsOgg",
    ]);
    expect(typeof player.createEngineNode).toBe("function");
    expect(typeof player.createPlayer).toBe("function");
    expect(typeof player.loadManifest).toBe("function");
    expect(typeof player.supportsOgg).toBe("function");
  });
});
