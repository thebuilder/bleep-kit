// Packs the publishable packages the way they would be published, unpacks the tarballs into a scratch project, and
// checks them there: no workspace: protocol left in a manifest, every export and bin target exists in the tarball,
// the built JavaScript imports in Node, TypeScript type-checks a consumer under strict settings, and the CLI bin runs.
//   node scripts/check-packages.ts
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSC = path.join(ROOT, "node_modules/.bin/tsc");
// in dependency order: each package's prepack builds against the ones before it
const PACKAGES = [
  { dir: "packages/core", name: "@bleepkit/core" },
  { dir: "packages/sfx", name: "@bleepkit/sfx" },
  { dir: "packages/player", name: "@bleepkit/player" },
  { dir: "packages/cli", name: "bleepkit" },
];
const run = (cmd: string, args: string[], cwd: string) =>
  execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

type Target = string | { [condition: string]: Target } | null;
interface Manifest {
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  exports?: Target;
}

/** Every file path an exports map points at. */
function exportTargets(target: Target | undefined): string[] {
  if (typeof target === "string") {
    return [target];
  }
  if (target && typeof target === "object") {
    return Object.values(target).flatMap(exportTargets);
  }
  return [];
}

/** Link a package's npm dependencies into the scratch project, resolved from the workspace install. */
function linkDependencies(
  pkg: { dir: string },
  manifest: Manifest,
  into: string
) {
  const external = Object.keys(manifest.dependencies ?? {}).filter(
    (dep) => !PACKAGES.some((p) => p.name === dep)
  );
  for (const dep of external) {
    const from = fs.realpathSync(path.join(ROOT, pkg.dir, "node_modules", dep));
    const to = path.join(into, "node_modules", dep);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.rmSync(to, { force: true });
    fs.symlinkSync(from, to, "dir");
  }
}

const project = fs.mkdtempSync(path.join(os.tmpdir(), "bleepkit-packages-"));
const tarballs = path.join(project, "tarballs");
try {
  fs.mkdirSync(tarballs);
  for (const pkg of PACKAGES) {
    run(
      "pnpm",
      ["pack", "--pack-destination", tarballs],
      path.join(ROOT, pkg.dir)
    );
    const tgz = fs
      .readdirSync(tarballs)
      .find((f) => f.startsWith(pkg.name.replace("@", "").replace("/", "-")));
    if (!tgz) {
      throw new Error(`no tarball for ${pkg.name}`);
    }
    const dest = path.join(project, "node_modules", pkg.name);
    fs.mkdirSync(dest, { recursive: true });
    run(
      "tar",
      ["-xzf", path.join(tarballs, tgz), "-C", dest, "--strip-components=1"],
      project
    );
    fs.rmSync(path.join(tarballs, tgz));
    const manifest: Manifest = JSON.parse(
      fs.readFileSync(path.join(dest, "package.json"), "utf8")
    );
    if (JSON.stringify(manifest).includes("workspace:")) {
      throw new Error(
        `${pkg.name}: workspace: protocol left in the published package.json`
      );
    }
    const bins =
      typeof manifest.bin === "string"
        ? [manifest.bin]
        : Object.values(manifest.bin ?? {});
    for (const file of [...exportTargets(manifest.exports), ...bins]) {
      if (file.includes("/src/") || !fs.existsSync(path.join(dest, file))) {
        throw new Error(`${pkg.name}: ${file} is not in the tarball`);
      }
    }
    linkDependencies(pkg, manifest, project);
  }
  fs.writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({ type: "module" })
  );

  // Node: import the built JavaScript
  fs.writeFileSync(
    path.join(project, "use.mjs"),
    `await import("@bleepkit/core");
await import("@bleepkit/core/tools");
await import("@bleepkit/sfx");
await import("@bleepkit/player");
console.log("imports ok");`
  );
  console.log(run("node", ["use.mjs"], project).trim());

  // TypeScript: a consumer type-checks against the published .d.ts files, as strictly as \`tsc --init\`
  fs.writeFileSync(
    path.join(project, "consumer.ts"),
    `import * as core from "@bleepkit/core";
import * as tools from "@bleepkit/core/tools";
import * as sfx from "@bleepkit/sfx";
import * as player from "@bleepkit/player";
export const all = [core, tools, sfx, player];
`
  );
  fs.writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        exactOptionalPropertyTypes: true,
        lib: ["es2023", "dom"],
        module: "nodenext",
        noEmit: true,
        noUncheckedIndexedAccess: true,
        strict: true,
        target: "es2023",
        types: [],
        verbatimModuleSyntax: true,
      },
      files: ["consumer.ts"],
    })
  );
  run(TSC, ["-p", project], project);
  console.log("consumer type-checks against the published types");

  // CLI: the published bin is the bundle, and it runs with plain Node
  const bin = path.join(project, "node_modules/bleepkit/dist/index.mjs");
  run("node", [bin], project);
  console.log("CLI bin runs");
} finally {
  fs.rmSync(project, { force: true, recursive: true });
}
