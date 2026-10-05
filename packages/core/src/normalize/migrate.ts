/* Format migrations. They run before validation. Today there is one format version, so migrate is the identity. */

import type { Rec } from "./issues.ts";

/** Bring a document written at `fromVersion` up to the current FORMAT_VERSION. */
export function migrate(doc: Rec, _fromVersion: number): Rec {
  return doc;
}
