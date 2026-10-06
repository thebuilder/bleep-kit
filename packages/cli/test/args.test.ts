import { describe, expect, it } from "vitest";
import { type FlagSpec, parseArgs } from "../src/args.ts";
import { CliError } from "../src/output.ts";

const flags: FlagSpec[] = [
  { description: "n", name: "count", type: "number" },
  { description: "s", name: "out", type: "string", values: ["a", "b"] },
  { description: "b", name: "open", type: "boolean" },
  { description: "l", name: "mml", type: "list" },
];

/** The CliError parseArgs throws for these arguments (the test fails when it does not throw). */
function usageError(argv: string[]): CliError {
  let thrown: unknown;
  try {
    parseArgs(argv, flags, "render");
  } catch (error) {
    thrown = error;
  }
  expect(
    thrown,
    `parseArgs(${JSON.stringify(argv)}) should throw`
  ).toBeInstanceOf(CliError);
  return thrown as CliError;
}

describe("parseArgs", () => {
  it("collects positionals and typed flags, with a value after a space or after =", () => {
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

  it("supports --no-<flag> and --flag=false for booleans, and leaves unset flags undefined", () => {
    expect(parseArgs(["--no-open"], flags, "t").bool("open")).toBe(false);
    expect(parseArgs(["--open=false"], flags, "t").bool("open")).toBe(false);
    const p = parseArgs([], flags, "t");
    expect(p.bool("open")).toBeUndefined();
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

  it("accepts negative numbers as values, with a space or after =", () => {
    expect(parseArgs(["--seed", "-5"], [], "t").num("seed")).toBe(-5);
    expect(parseArgs(["--count=-0.5"], flags, "t").num("count")).toBe(-0.5);
  });

  it("knows the global flags and their short aliases on every command", () => {
    const p = parseArgs(["-q", "--json", "--project", "x/y"], [], "t");
    expect(p.bool("quiet")).toBe(true);
    expect(p.bool("json")).toBe(true);
    expect(p.str("project")).toBe("x/y");
  });

  it("rejects unknown flags with a suggestion", () => {
    const e = usageError(["--cuont", "3"]);
    expect(e.code).toBe("usage");
    expect(e.hint).toContain("--count");
  });

  it("rejects bad numbers, bad enum values and missing values", () => {
    expect(usageError(["--count", "abc"]).message).toMatch(/needs a number/);
    expect(usageError(["--count", "Infinity"]).message).toMatch(
      /needs a number/
    );
    expect(usageError(["--count="]).message).toMatch(/needs a number/);
    expect(usageError(["--out", "z"]).message).toMatch(/one of a, b/);
    expect(usageError(["--out"]).message).toMatch(/needs a value/);
  });

  it("does not swallow the next flag as a value", () => {
    expect(usageError(["--out", "--open"]).message).toMatch(/needs a value/);
    expect(usageError(["--count", "--open"]).message).toMatch(/needs a value/);
  });

  it("treats everything after -- as positional", () => {
    const p = parseArgs(["a", "--", "--count", "--open"], flags, "t");
    expect(p.positionals).toEqual(["a", "--count", "--open"]);
    expect(p.has("count")).toBe(false);
  });
});
