import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../src/cli.ts";

export const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));

export interface RunResult {
  code: number;
  // biome-ignore lint/suspicious/noExplicitAny: test helper over arbitrary JSON
  json: any;
  stderr: string;
  stdout: string;
}

function parse(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** Runs the CLI in this process (fast, and it counts for coverage): the same `main` the entry point calls. */
export async function run(cwd: string, args: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(args, {
    cwd,
    isTTY: false,
    stderr: (t) => {
      stderr += t;
    },
    stdout: (t) => {
      stdout += t;
    },
  });
  return { code, json: parse(stdout), stderr, stdout };
}

/** Runs the real entry point (`node src/index.ts`) the way a developer or agent would. */
export function runProcess(cwd: string, args: string[]): RunResult {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, BLEEPKIT_DEBUG: "" },
  });
  return {
    code: r.status ?? -1,
    json: parse(r.stdout),
    stderr: r.stderr,
    stdout: r.stdout,
  };
}

export function tempDir(prefix = "bleepkit-cli-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** A fresh project in a temp dir: `init` then one extra sfx. Returns the repo dir and the project dir. */
export async function makeProject(
  chip = "nes"
): Promise<{ project: string; repo: string }> {
  const repo = tempDir();
  const r = await run(repo, ["init", "--chip", chip, "--json"]);
  if (r.code !== 0) {
    throw new Error(`init failed: ${r.stderr}`);
  }
  return { project: path.join(repo, "audio"), repo };
}
