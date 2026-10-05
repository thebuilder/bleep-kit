/**
 * The version of the sound the engine makes. A render is a pure function of its inputs and this number: the CLI puts it
 * in every render hash, so bumping it makes every render in `out/` stale and the next `render` or `export` redoes it.
 *
 * Bump it, as a string, in the same change that moves a golden hash on purpose (a new filter curve, a different
 * envelope shape, a changed sequencer rule). `test/golden.test.ts` stores the version in each golden file and refuses to
 * regenerate hashes under a version it already holds, so a changed sound cannot ship without invalidating old renders.
 */
export const ENGINE_VERSION = "2";

/*
 * History, newest first:
 *   "2"  A note slide (Qxy, Rxy) on the row of its note now moves that note. It used to be reset by the note starting,
 *        so the effect only worked on a row without a note. No golden hash moved: no fixture song uses it on a note.
 *   "1"  The first release.
 */
