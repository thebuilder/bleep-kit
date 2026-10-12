// What the tools need from the application they run in. The studio implements it on top of its project store, render
// worker and engine; an MCP server would implement it on a project folder and the CLI's render pipeline. The tools
// know nothing else about where they run: no UI, no storage, no audio device.
import type { ChipId, Instrument, Project, Sfx, Song } from "@bleepkit/core";
import type { Analysis } from "@bleepkit/core/tools";

export type DocKind = "sfx" | "instrument" | "song";
export const DOC_KINDS: readonly DocKind[] = ["sfx", "song", "instrument"];

export interface DocRef {
  id: string;
  kind: DocKind;
}

export type AnyDoc = Sfx | Instrument | Song;

/** One row of the project listing. */
export interface DocSummary extends DocRef {
  /** sfx: its category; instrument: its kind; song: null. */
  detail: string | null;
  name: string;
}

export interface ProjectSummary {
  chip: ChipId;
  master: Project["master"];
  name: string;
  sampleRate: Project["sampleRate"];
  seed: number;
}

export type ImageKind = "waveform" | "spectrogram" | "scopes";

export interface AgentImage {
  /** Base64 of the PNG bytes. */
  data: string;
  height: number;
  kind: ImageKind;
  mime: "image/png";
  width: number;
}

/** The result of rendering a document: the numbers (and, on request, the pictures of them). */
export interface Measured {
  analysis: Analysis;
  /** Which pictures `images()` can draw for it (scopes only for songs). */
  imageKinds: ImageKind[];
}

export interface AgentHost {
  /** Render and measure a document. An instrument is measured by playing `note` (default 60) on it. */
  analyze: (ref: DocRef, opts?: { note?: number }) => Promise<Measured>;
  /** The document being looked at right now, if the application has such a thing. */
  current: () => DocRef | null;
  /** Pictures of the last (or a fresh) measurement of `ref`, as PNG. */
  images: (
    ref: DocRef,
    kinds: readonly ImageKind[],
    opts?: { note?: number }
  ) => Promise<AgentImage[]>;
  /** Every instrument by id, for normalizing songs and for the tools that pick one. */
  instruments: () => Promise<Record<string, Instrument>>;
  list: (kind?: DocKind) => Promise<DocSummary[]>;
  /** Make the document audible. Resolves when playback has started, not when it ends. */
  play: (ref: DocRef) => Promise<void>;
  project: () => Promise<ProjectSummary>;
  /** The normalized document, or null when there is none. */
  read: (ref: DocRef) => Promise<AnyDoc | null>;
  /**
   * Delete a document. The host asks the person first (a dialog): `deleted` is false when they said no, `missing`
   * when there was nothing to delete.
   */
  remove: (ref: DocRef) => Promise<{ deleted: boolean; missing: boolean }>;
  stop: () => Promise<void>;
  /**
   * Store a document that the tools have already normalized and found valid. Returns whether it was created or
   * replaced an existing one.
   */
  write: (ref: DocRef, value: AnyDoc) => Promise<{ created: boolean }>;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isDocId = (id: string): boolean => ID_RE.test(id);

export const refText = (ref: DocRef): string => `${ref.kind}/${ref.id}`;

/** "sfx/coin" to a reference, or why not. A bare id is refused: the kind must be named. */
export function parseRef(text: unknown): DocRef | string {
  if (typeof text !== "string") {
    return 'ref must be a string like "sfx/coin", "song/title" or "instrument/lead"';
  }
  const [kind, id, ...rest] = text.trim().split("/");
  if (kind === "songs" || kind === "instruments") {
    return `use "${kind.slice(0, -1)}/${id ?? ""}" (singular kind)`;
  }
  if (
    !(kind && (DOC_KINDS as readonly string[]).includes(kind)) ||
    rest.length
  ) {
    return `"${text}" is not a document reference: write the kind, a slash and the id, like "sfx/coin", "song/title" or "instrument/lead"`;
  }
  if (!(id && ID_RE.test(id))) {
    return `"${id ?? ""}" is not a valid id: lowercase letters, digits and dashes, starting with a letter or digit (up to 64)`;
  }
  return { id, kind: kind as DocKind };
}
