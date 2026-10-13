// The Freesound routes of the studio server: /api/freesound/* is answered by the same handler as the studio's Vercel
// Function (apps/studio/server/freesound), with the API key from the environment. The studio's dev server does the same
// from .env.local; this is for `bleepkit studio` serving the built studio. Without FREESOUND_CLIENT_SECRET the routes
// answer "not configured" and the studio's Freesound tab says so.
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import type { FreesoundEnv } from "../../../../apps/studio/server/freesound/env.ts";

const KEYS = ["FREESOUND_CLIENT_SECRET", "FREESOUND_CLIENT_ID"] as const;

/** The Freesound variables: the process environment first, then `.env.local` in the working directory and next to the built studio. */
export function freesoundEnv(studioDist: string | null): FreesoundEnv {
  const env: FreesoundEnv = {};
  for (const key of KEYS) {
    env[key] = process.env[key];
  }
  const folders = [
    process.cwd(),
    ...(studioDist ? [path.dirname(studioDist)] : []),
  ];
  for (const folder of folders) {
    let parsed: Record<string, string | undefined> = {};
    try {
      parsed = parseEnv(
        fs.readFileSync(path.join(folder, ".env.local"), "utf8")
      );
    } catch {
      continue;
    }
    for (const key of KEYS) {
      env[key] ||= parsed[key];
    }
  }
  return env;
}
