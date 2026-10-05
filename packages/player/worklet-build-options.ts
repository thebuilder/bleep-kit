// The esbuild settings for the worklet bundle, shared by build-worklet.ts and the bundle test.
import type { BuildOptions } from "esbuild";

export function workletBuildOptions(root: string): BuildOptions {
  return {
    bundle: true,
    entryPoints: [`${root}/src/worklet/processor.ts`],
    format: "esm",
    legalComments: "none",
    minify: false,
    outfile: `${root}/worklet/bleepkit-worklet.js`,
    platform: "neutral",
    sourcemap: false,
    target: "es2022",
  };
}
