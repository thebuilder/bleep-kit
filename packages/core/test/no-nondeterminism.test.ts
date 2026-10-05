/* Section 3.10: nothing in core, sfx or player sources may read randomness or a clock. Audio is a pure function of its
   inputs and the seed, so Math.random, Date, performance and crypto are banned. This test greps the three packages. */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = ["core", "sfx", "player"].map((p) => join(PACKAGES, p, "src"));

/* Files allowed to read a clock, by path relative to packages/. The CPU load meter of the worklet needs a clock: it
   times `process` and reports `load` in `clock` messages for the studio's meter. The reading never reaches the audio
   path (it only feeds that one number), so it cannot change a sample, and the file takes its clock from an injected
   host object (`globalThis` by default) so tests can stub it. Nothing else may be listed here. */
const CLOCK_EXEMPT: ReadonlySet<string> = new Set([
  "player/src/worklet/load-meter.ts",
]);

/* Real uses only. Reading a clock off an injected host object (`host.performance`) is how the worklet load meter stays
   outside the audio path, so a bare property name does not count, a call on the global does. */
const BANNED: readonly { name: string; re: RegExp }[] = [
  { name: "Math.random", re: /\bMath\s*\.\s*random\b/ },
  {
    name: "Date",
    re: /\bnew\s+Date\b|(?<![.\w])Date\s*\.\s*(?:now|parse|UTC)\b|(?<![.\w])Date\s*\(/,
  },
  {
    name: "performance",
    re: /(?<![.\w])performance\s*\.\s*(?:now|mark|measure|timeOrigin)\b|globalThis\s*\.\s*performance\s*\.\s*now/,
  },
  {
    name: "crypto",
    re: /(?<![.\w])crypto\s*\.\s*(?:getRandomValues|randomUUID|randomBytes|subtle)\b|from\s+["'](?:node:)?crypto["']|require\(\s*["'](?:node:)?crypto["']\s*\)/,
  },
];

function stripComments(src: string): string {
  // block comments and line comments (a "//" inside a string is rare enough in these sources; urls are in comments)
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function findViolations(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const b of BANNED) {
    if (b.re.test(code)) {
      out.push(b.name);
    }
  }
  return out;
}

function walk(dir: string, into: string[]): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (name !== "node_modules") {
        walk(path, into);
      }
    } else if (/\.(?:ts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) {
      into.push(path);
    }
  }
}

describe("no nondeterminism in core, sfx and player", () => {
  it("the scanner catches the banned calls", () => {
    expect(findViolations("const x = Math.random();")).toEqual(["Math.random"]);
    expect(findViolations("const t = new Date();")).toEqual(["Date"]);
    expect(findViolations("const t = Date.now();")).toEqual(["Date"]);
    expect(findViolations("const t = performance.now();")).toEqual([
      "performance",
    ]);
    expect(findViolations("crypto.getRandomValues(a);")).toEqual(["crypto"]);
    expect(
      findViolations('import { randomBytes } from "node:crypto";')
    ).toEqual(["crypto"]);
  });

  it("the scanner ignores comments and injected host properties", () => {
    expect(findViolations("// Math.random is banned\nconst a = 1;")).toEqual(
      []
    );
    expect(
      findViolations("/* Date.now() and performance.now() */ const a = 1;")
    ).toEqual([]);
    expect(
      findViolations("const p = host.performance; const d = host.Date;")
    ).toEqual([]);
    expect(
      findViolations("const dateOfBirth = 1; const updateDate = 2;")
    ).toEqual([]);
  });

  it("finds the source trees", () => {
    for (const root of ROOTS) {
      const files: string[] = [];
      walk(root, files);
      expect(files.length, `no sources under ${root}`).toBeGreaterThan(0);
    }
  });

  it("every exempt file exists, so an exemption cannot go stale", () => {
    for (const rel of CLOCK_EXEMPT) {
      expect(statSync(join(PACKAGES, rel)).isFile()).toBe(true);
    }
  });

  it("no source uses Math.random, Date, performance or crypto", () => {
    const bad: string[] = [];
    let scanned = 0;
    for (const root of ROOTS) {
      const files: string[] = [];
      walk(root, files);
      for (const file of files) {
        if (
          CLOCK_EXEMPT.has(file.slice(PACKAGES.length).replaceAll("\\", "/"))
        ) {
          continue;
        }
        scanned += 1;
        const found = findViolations(readFileSync(file, "utf8"));
        if (found.length > 0) {
          bad.push(`${file.slice(PACKAGES.length)}: ${found.join(", ")}`);
        }
      }
    }
    expect(scanned).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });
});
