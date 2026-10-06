// @vitest-environment node
/* The worklet ships as one self-contained file. Build it in memory (the same options as build-worklet.ts), then run it
   the way an AudioWorkletGlobalScope would: no imports, no DOM, and a registerProcessor to call. */

import { build } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workletBuildOptions } from "../worklet-build-options.ts";

const EXPORT_LIST = /^export\s*\{[^}]*\};?\s*$/m;
const ROOT = decodeURIComponent(
  new URL("..", import.meta.url).pathname
).replace(/\/$/, "");

async function bundle() {
  const { outfile: _outfile, ...options } = workletBuildOptions(ROOT);
  const result = await build({ ...options, metafile: true, write: false });
  const file = result.outputFiles?.[0];
  if (!file) {
    throw new Error("esbuild produced nothing");
  }
  const [output] = Object.values(result.metafile.outputs);
  return { code: file.text, imports: output?.imports ?? [] };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("worklet bundle", () => {
  it("is self-contained: nothing is left to import when the worklet loads it", async () => {
    // an AudioWorkletGlobalScope resolves no bare specifiers and has no module loader beyond the one file
    const { imports } = await bundle();
    expect(imports).toEqual([]);
  });

  it("registers bleepkit-engine when evaluated in a worklet-like scope without browser globals", async () => {
    const { code } = await bundle();
    const registered: string[] = [];
    class Base {
      port = { onmessage: null, postMessage: () => undefined };
    }
    vi.stubGlobal("AudioWorkletProcessor", Base);
    vi.stubGlobal("registerProcessor", (name: string) => registered.push(name));
    vi.stubGlobal("currentTime", 0);
    vi.stubGlobal("sampleRate", 48_000);
    // the file is an ES module without imports: drop its export list and run it as a script. The node environment
    // has no window or document, so a bundle that touched them while loading would throw here.
    const script = code.replace(EXPORT_LIST, "");
    new Function(script)();
    expect(registered).toEqual(["bleepkit-engine"]);
  });
});
