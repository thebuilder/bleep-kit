/* Where the export lands, in the two places the studio runs.

   The project stores `export.dir` and `export.manifest` the way the CLI reads them: paths relative to the project
   folder on disk (the defaults are "../public/audio" and "../src/audio.ts", because the project folder usually sits
   inside the game). A website has no folder to write to: Export downloads a zip laid out like the game project
   ("public/audio/...", "src/audio.ts"), so the browser shows and edits that zip layout instead.

   The mapping between the two is the stored path with its leading "../" dropped, and back: a zip path "public/audio"
   is stored as "../public/audio". That is the form the CLI already understands, so a project exported from the browser
   and later opened with the CLI still writes next to the project folder, exactly where the zip would have unpacked.
   Nothing is rewritten unless the person edits the field: an untouched stored value (even one the browser cannot
   show, like an absolute disk path) is kept as it is. */
import { cleanPath } from "./export-preview.ts";
import type { Project } from "./lib/contract.ts";

export const DEFAULT_DIR = "../public/audio";
export const DEFAULT_MANIFEST = "../src/audio.ts";

const WINDOWS_DRIVE = /^[A-Za-z]:/;
const BACKSLASH = /\\/g;

/** "/home/me/game/audio", "C:/game", "~/game": a place on one particular disk, which means nothing in a zip. */
const isDiskPath = (p: string): boolean =>
  p.startsWith("/") || p.startsWith("~") || WINDOWS_DRIVE.test(p);

const normal = (p: string): string => p.trim().replace(BACKSLASH, "/");

/** The zip path for a stored path: leading "../" dropped, and the default when the stored value is a disk path. */
export function zipPath(stored: string, fallback: string): string {
  const p = normal(stored);
  return (isDiskPath(p) ? "" : cleanPath(p)) || cleanPath(fallback);
}

/** Where the browser's zip puts the audio files and the typed manifest, following the project's settings. */
export function zipLayout(exp: Pick<Project["export"], "dir" | "manifest">): {
  dir: string;
  manifest: string;
} {
  return {
    dir: zipPath(exp.dir, DEFAULT_DIR),
    manifest: zipPath(exp.manifest, DEFAULT_MANIFEST),
  };
}

/** What to store after the person typed `typed` as a zip path (`current` is what is stored now). */
export function storedFromZip(
  typed: string,
  current: string,
  fallback: string
): string {
  const clean = cleanPath(normal(typed));
  if (!clean) {
    return fallback;
  }
  if (!isDiskPath(normal(current)) && zipPath(current, fallback) === clean) {
    return current;
  }
  return `../${clean}`;
}

export interface ExportFieldCopy {
  dirHint: string;
  dirLabel: string;
  dirPlaceholder: string;
  manifestHint: string;
  manifestLabel: string;
  manifestPlaceholder: string;
  urlHint: string;
}

const URL_HINT =
  "Where your game serves the audio files from, for example /audio/.";

/** The labels and hints of the path fields: zip paths in the browser, disk paths when the CLI studio runs a folder. */
export function exportFieldCopy(local: boolean): ExportFieldCopy {
  if (local) {
    return {
      dirHint: "Unzip into your game's project root.",
      dirLabel: "Audio folder in the zip",
      dirPlaceholder: "public/audio/",
      manifestHint: "",
      manifestLabel: "Manifest file in the zip",
      manifestPlaceholder: "src/audio.ts",
      urlHint: URL_HINT,
    };
  }
  return {
    dirHint: "The CLI writes the audio files here.",
    dirLabel: "Audio folder (relative to the project)",
    dirPlaceholder: DEFAULT_DIR,
    manifestHint: "The CLI writes the typed manifest here.",
    manifestLabel: "Manifest file (relative to the project)",
    manifestPlaceholder: DEFAULT_MANIFEST,
    urlHint: URL_HINT,
  };
}
