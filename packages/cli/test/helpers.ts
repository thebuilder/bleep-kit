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

/** A fresh project in a temp dir (`init`, which writes three instruments and the starter sfx `coin`). Returns the repo dir and the project dir (`<repo>/audio`). */
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

export interface WavFile {
  bitsPerSample: number;
  channels: number;
  frames: number;
  /** The LIST INFO entries, for example `{ ISFT: "bleepkit 0.1.0", ICMT: "coin" }`. */
  info: Record<string, string>;
  /** The first loop of the `smpl` chunk, in frames, as stored (`end` is the last frame of the loop, inclusive). */
  loop: { end: number; start: number } | null;
  sampleRate: number;
  /** All samples, interleaved, scaled to -1..1. */
  samples: Float64Array;
}

/**
 * A deliberately small RIFF/WAVE reader for 16-bit PCM masters, written from the container spec and independent of
 * `@bleepkit/core/tools`, so a test can check what the CLI reports against the bytes it actually wrote.
 */
export function readWav(file: string): WavFile {
  const b = fs.readFileSync(file);
  if (
    b.toString("latin1", 0, 4) !== "RIFF" ||
    b.toString("latin1", 8, 12) !== "WAVE"
  ) {
    throw new Error(`${file} is not a RIFF/WAVE file`);
  }
  const wav: WavFile = {
    bitsPerSample: 0,
    channels: 0,
    frames: 0,
    info: {},
    loop: null,
    sampleRate: 0,
    samples: new Float64Array(0),
  };
  let offset = 12;
  while (offset + 8 <= b.length) {
    const id = b.toString("latin1", offset, offset + 4);
    const size = b.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      wav.channels = b.readUInt16LE(body + 2);
      wav.sampleRate = b.readUInt32LE(body + 4);
      wav.bitsPerSample = b.readUInt16LE(body + 14);
    } else if (id === "data") {
      const count = size / 2;
      wav.samples = new Float64Array(count);
      for (let i = 0; i < count; i += 1) {
        wav.samples[i] = b.readInt16LE(body + i * 2) / 32_768;
      }
      wav.frames = count / wav.channels;
    } else if (id === "smpl" && b.readUInt32LE(body + 28) > 0) {
      // 36 byte header, then loops of 24 bytes: id, type, start, end, fraction, play count
      wav.loop = {
        end: b.readUInt32LE(body + 36 + 12),
        start: b.readUInt32LE(body + 36 + 8),
      };
    } else if (
      id === "LIST" &&
      b.toString("latin1", body, body + 4) === "INFO"
    ) {
      let at = body + 4;
      while (at + 8 <= body + size) {
        const key = b.toString("latin1", at, at + 4);
        const len = b.readUInt32LE(at + 4);
        wav.info[key] = b
          .toString("latin1", at + 8, at + 8 + len)
          .replace(/\0+$/, "");
        at += 8 + len + (len % 2);
      }
    }
    offset = body + size + (size % 2);
  }
  return wav;
}

/** Peak and RMS of every sample in dBFS, the way the CLI documents them (all channels together). */
export function wavLevels(wav: WavFile): { peakDb: number; rmsDb: number } {
  let peak = 0;
  let sum = 0;
  for (const v of wav.samples) {
    peak = Math.max(peak, Math.abs(v));
    sum += v * v;
  }
  return {
    peakDb: 20 * Math.log10(peak),
    rmsDb: 20 * Math.log10(Math.sqrt(sum / wav.samples.length)),
  };
}
