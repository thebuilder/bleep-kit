// The generated audio.ts is a contract with the game (architecture.md section 7): `createPlayer({ manifest })` must
// type `player.sfx(id)` and `player.music(id)` by the exported ids. This type-checks the real output of `bleepkit
// export` with tsc, in a scratch project inside the workspace so `@bleepkit/player` resolves to the package itself.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { makeProject, readJson, run, writeJson } from "./helpers.ts";

const CLI_DIR = fileURLToPath(new URL("..", import.meta.url));
const PACKAGES_DIR = path.resolve(CLI_DIR, "..");
const TSC = path.resolve(CLI_DIR, "../../node_modules/.bin/tsc");

const scratch: string[] = [];

/** A consumer project: strict like `tsc --init`, with `@bleepkit/player` and `@bleepkit/core` linked from the workspace. */
function consumerProject(): string {
  const dir = fs.mkdtempSync(path.join(CLI_DIR, ".tmp-audio-ts-"));
  scratch.push(dir);
  const scope = path.join(dir, "node_modules", "@bleepkit");
  fs.mkdirSync(scope, { recursive: true });
  for (const name of ["core", "player"]) {
    fs.symlinkSync(
      path.join(PACKAGES_DIR, name),
      path.join(scope, name),
      "dir"
    );
  }
  writeJson(path.join(dir, "package.json"), { type: "module" });
  writeJson(path.join(dir, "tsconfig.json"), {
    compilerOptions: {
      allowImportingTsExtensions: true,
      exactOptionalPropertyTypes: true,
      lib: ["es2023", "dom"],
      module: "nodenext",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      skipLibCheck: true,
      strict: true,
      target: "es2023",
      types: [],
      verbatimModuleSyntax: true,
    },
    files: ["audio.ts", "game.ts"],
  });
  return dir;
}

/** The game side: ids come from the generated manifest, and a wrong id must not compile. */
const GAME_TS = `import { createPlayer } from "@bleepkit/player";
import { manifest, type SfxId, type SongId } from "./audio.ts";

const player = await createPlayer({ manifest });
const sfxId: SfxId = "coin";
player.sfx("coin");
player.sfx(sfxId);
// @ts-expect-error not an id of this manifest
player.sfx("no-such-sound");
// @ts-expect-error a song id is not an sfx id
player.sfx("title");
const songId: SongId = "title";
await player.music(songId);
// @ts-expect-error not a song id
await player.music("coin");
`;

function typecheck(dir: string): string {
  try {
    execFileSync(TSC, ["-p", dir], { cwd: dir, encoding: "utf8" });
    return "";
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    return stdout ?? String(error);
  }
}

async function exportAudioTs(embed: boolean): Promise<string> {
  const { project, repo } = await makeProject();
  const file = path.join(project, "project.json");
  const p = readJson(file) as { export: Record<string, unknown> };
  writeJson(file, {
    ...p,
    export: { ...p.export, musicFormat: "wav", sfxFormat: "wav" },
  });
  const song = await run(repo, [
    "new",
    "song",
    "title",
    "--mml",
    "pulse1=@lead c d e",
  ]);
  expect(song.code, song.stderr).toBe(0);
  const consumer = consumerProject();
  const r = await run(repo, [
    "export",
    "--manifest",
    path.join(consumer, "audio.ts"),
    ...(embed ? ["--embed"] : []),
    "--json",
  ]);
  expect(r.code, r.stderr).toBe(0);
  fs.writeFileSync(path.join(consumer, "game.ts"), GAME_TS);
  return consumer;
}

afterAll(() => {
  for (const dir of scratch) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("generated audio.ts", () => {
  it("type-checks against @bleepkit/player: ids are typed, wrong ids do not compile", async () => {
    const consumer = await exportAudioTs(false);
    expect(typecheck(consumer)).toBe("");
  });

  it("still type-checks with the documents embedded", async () => {
    const consumer = await exportAudioTs(true);
    const ts = fs.readFileSync(path.join(consumer, "audio.ts"), "utf8");
    // without this the test would be the one above: the documents really are in the file
    expect(ts).toContain('category: "coin"');
    expect(typecheck(consumer)).toBe("");
  });
});
