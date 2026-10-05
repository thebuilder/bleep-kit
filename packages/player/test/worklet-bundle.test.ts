// @vitest-environment node
/* The worklet ships as one self-contained file. Build it in memory (the same options as build-worklet.ts), then run it
   the way an AudioWorkletGlobalScope would: no imports, no DOM, and a registerProcessor to call. */

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workletBuildOptions } from "../worklet-build-options.ts";

const IMPORT_LINE = /^\s*import\s/m;
const REQUIRE_CALL = /\brequire\(/;
const BROWSER_GLOBALS = /\bwindow\b|\bdocument\b/;
const EXPORT_LIST = /^export\s*\{[^}]*\};?\s*$/m;
const ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname
).replace(/\/$/, "");

async function bundle(): Promise<string> {
  const { outfile: _outfile, ...options } = workletBuildOptions(ROOT);
  const result = await build({ ...options, write: false });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error("esbuild produced nothing");
  }
  return file.text;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worklet bundle", () => {
  it("is plain ES module code with no imports left", async () => {
    const code = await bundle();
    expect(code).not.toMatch(IMPORT_LINE);
    expect(code).not.toMatch(REQUIRE_CALL);
    expect(code).not.toMatch(BROWSER_GLOBALS);
  });

  it("registers bleepkit-engine when evaluated in a worklet-like scope", async () => {
    const code = await bundle();
    const registered: string[] = [];
    class Base {
      port = { onmessage: null, postMessage: () => undefined };
    }
    vi.stubGlobal("AudioWorkletProcessor", Base);
    vi.stubGlobal("registerProcessor", (name: string) => registered.push(name));
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("sampleRate", 48_000);
    // the file is an ES module without imports: drop its export list and run it as a script
    const script = code.replace(EXPORT_LIST, "");
    new Function(script)();
    expect(registered).toEqual(["bleepkit-engine"]);
  });
});
