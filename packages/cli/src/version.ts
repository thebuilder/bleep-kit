// The CLI's version, written into the files it makes (the WAV `ISFT` chunk) and printed by `--version`.
// Keep it equal to package.json: test/version.test.ts fails when they differ. It is a literal, not a read of
// package.json, because the published CLI is one esbuild bundle with no package.json next to it.

export const VERSION = "0.1.0";

/** The `software` string of the WAV files the CLI writes. */
export const SOFTWARE = `bleepkit ${VERSION}`;
