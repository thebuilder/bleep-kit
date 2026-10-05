// Bundles the CLI into dist/index.mjs, the file the published `bleepkit` bin runs. The workspace packages (and the
// code they pull in) are inlined; the npm dependencies stay external and are installed next to the CLI.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(HERE, "package.json"), "utf8")
) as { dependencies?: Record<string, string> };

await build({
  bundle: true,
  entryPoints: [path.join(HERE, "src/index.ts")],
  external: Object.keys(manifest.dependencies ?? {}),
  format: "esm",
  outfile: path.join(HERE, "dist/index.mjs"),
  platform: "node",
  target: "node22",
});
process.stdout.write("cli: dist/index.mjs\n");
