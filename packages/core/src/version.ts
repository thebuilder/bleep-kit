/**
 * The version of the sound the engine makes. A render is a pure function of its inputs and this number: the CLI puts it
 * in every render hash, so bumping it makes every render in `out/` stale and the next `render` or `export` redoes it.
 *
 * Bump it, as a string, in the same change that moves a golden hash on purpose (a new filter curve, a different
 * envelope shape, a changed sequencer rule). `test/golden.test.ts` stores the version in each golden file and refuses to
 * regenerate hashes under a version it already holds, so a changed sound cannot ship without invalidating old renders.
 */
export const ENGINE_VERSION = "3";

/*
 * History, newest first:
 *   "3"  Gain staging and loops. Chips are leveled once in core (a full-volume square peaks -12 dBFS on every chip),
 *        FM level maps linearly to TL in dB (modulators no longer near silent) and FM key-on resets operator state,
 *        the sfx FM index is in radians (divided by 2 pi), PSG noise on genesis follows tone3, the noise lift is capped,
 *        SNES drum generators peak at 0.95, sfx honor the master volume (default 0.8), and a looping song renders at
 *        least two passes with the tick grid restarted at each loop so the seam is clean. Every golden hash moved.
 *   "2"  A note slide (Qxy, Rxy) on the row of its note now moves that note. It used to be reset by the note starting,
 *        so the effect only worked on a row without a note. No golden hash moved: no fixture song uses it on a note.
 *   "1"  The first release.
 */
