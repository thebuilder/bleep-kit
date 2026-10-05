/* The one place the studio imports the frozen contract from (types and constants of section 2.2).
   It re-exports packages/core/src/types.ts; once @bleepkit/core exports everything from its index this file can read
   from the package instead, and nothing else in the studio changes. */
// biome-ignore lint/performance/noBarrelFile: single seam for the contract, see the note above
export * from "../../../../packages/core/src/types.ts";
