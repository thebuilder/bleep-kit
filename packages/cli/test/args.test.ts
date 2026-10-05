import { describe, expect, it } from "vitest";
import { type FlagSpec, parseArgs } from "../src/args.ts";
import { CliError } from "../src/output.ts";

const flags: FlagSpec[] = [
  { description: "n", name: "count", type: "number" },
  { description: "s", name: "out", type: "string", values: ["a", "b"] },
  { description: "b", name: "open", type: "boolean" },
  { description: "l", name: "mml", type: "list" },
];

describe("parseArgs", () => {
  it("collects positionals and typed flags", () => {
    const p = parseArgs(
      ["sfx", "coin", "--count", "3", "--out=a", "--open"],
      flags,
      "t"
    );
    expect(p.positionals).toEqual(["sfx", "coin"]);
    expect(p.num("count")).toBe(3);
    expect(p.str("out")).toBe("a");
    expect(p.bool("open")).toBe(true);
  });

  it("supports --no-<flag> for booleans and leaves unset flags undefined", () => {
    const p = parseArgs(["--no-open"], flags, "t");
    expect(p.bool("open")).toBe(false);
    expect(p.num("count")).toBeUndefined();
    expect(p.has("count")).toBe(false);
  });

  it("repeats list flags and keeps = inside values", () => {
    const p = parseArgs(
      ["--mml", "pulse1=o4 c", "--mml=noise=l8 c"],
      flags,
      "t"
    );
    expect(p.list("mml")).toEqual(["pulse1=o4 c", "noise=l8 c"]);
  });

  it("accepts negative numbers as values", () => {
    expect(parseArgs(["--seed", "-5"], [], "t").num("seed")).toBe(-5);
  });

  it("rejects unknown flags with a suggestion", () => {
    try {
      parseArgs(["--cuont", "3"], flags, "render");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      const e = error as CliError;
      expect(e.code).toBe("usage");
      expect(e.hint).toContain("--count");
    }
  });

  it("rejects bad numbers, bad enum values and missing values", () => {
    expect(() => parseArgs(["--count", "abc"], flags, "t")).toThrow(
      /needs a number/
    );
    expect(() => parseArgs(["--out", "z"], flags, "t")).toThrow(/one of a, b/);
    expect(() => parseArgs(["--out"], flags, "t")).toThrow(/needs a value/);
  });

  it("treats everything after -- as positional", () => {
    expect(parseArgs(["--", "--count"], flags, "t").positionals).toEqual([
      "--count",
    ]);
  });
});
