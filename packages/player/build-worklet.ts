// Bundles the AudioWorklet processor and @bleepkit/core into one self-contained module,
// worklet/bleepkit-worklet.js (gitignored). `import url from "@bleepkit/player/worklet?url"` serves it as is.
//   node build-worklet.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { workletBuildOptions } from "./worklet-build-options.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const options = workletBuildOptions(HERE);

await build(options);
const bytes = fs.statSync(path.join(HERE, "worklet/bleepkit-worklet.js")).size;
process.stdout.write(`player: worklet/bleepkit-worklet.js (${bytes} bytes)\n`);
