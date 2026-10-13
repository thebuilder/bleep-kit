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

/**
 * What the model may know about a user sample: everything except the audio. The data stays in the application (it is
 * megabytes of base64); the model assigns samples to instruments by id.
 */
export interface SampleInfo {
  baseNote: number;
  bits: 8 | 16;
  bytes: number;
  finetune: number;
  frames: number;
  id: string;
  loop: { end: number; start: number } | null;
  name: string;
  rate: number;
  seconds: number;
  volume: number;
}

/** What `resample` may be told: where the sample goes and how it is stored. */
export interface ResampleOptions {
  /** 8 crushes the sample to 8 bit. Default: the project chip's own (8 on amiga and genesis, 16 elsewhere). */
  bits?: 8 | 16;
  /** The new sample's id. */
  id: string;
  name?: string;
  /** For an instrument: the note to play (default 60), which becomes the sample's base note. */
  note?: number;
  /** Sample rate to store at, 1000 to 96000. */
  rate?: number;
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

/** One Freesound result as the model sees it. Only CC0 and CC BY sounds are ever offered; the host enforces that. */
export interface FreesoundHit {
  author: string;
  id: number;
  license: "CC0" | "CC BY";
  name: string;
  /** The note Freesound detected, when it is confident. */
  note: string | null;
  oneShot: boolean;
  seconds: number;
  subcategory: string | null;
  tags: string[];
}

/** What `search_freesound` may ask for. The host passes it to the studio's own whitelisted route. */
export interface FreesoundSearchOptions {
  /** "cc0" (the default) or "by", which adds CC BY sounds (the person must credit them). */
  license?: "by" | "cc0";
  maxSeconds?: number;
  oneShot?: boolean;
  page?: number;
  query?: string;
  sort?: "downloads" | "rating" | "relevance" | "shortest";
  subcategory?: "keys" | "other" | "percussion" | "string" | "synth" | "wind";
  tags?: string[];
}

export interface FreesoundSearchResult {
  count: number;
  hasMore: boolean;
  hits: FreesoundHit[];
  /** Things the service did on the way (a filter it had to drop). */
  notes: string[];
}

/** The Freesound sample browser, for hosts that have one (the studio, when its server has an API key). */
export interface FreesoundHost {
  /**
   * Import a sound a search returned in this session, as a user sample that remembers its author and license, and
   * with `instrument` also a sample instrument that plays it. Rejects for an id no search returned.
   */
  import: (
    id: number,
    opts: { instrument: string | null }
  ) => Promise<{
    hit: FreesoundHit;
    instrument: string | null;
    sample: SampleInfo;
  }>;
  search: (opts: FreesoundSearchOptions) => Promise<FreesoundSearchResult>;
}

export interface AgentHost {
  /** Render and measure a document. An instrument is measured by playing `note` (default 60) on it. */
  analyze: (ref: DocRef, opts?: { note?: number }) => Promise<Measured>;
  /** The document being looked at right now, if the application has such a thing. */
  current: () => DocRef | null;
  /** The Freesound sample browser. Absent where there is none; the Freesound tools are then left out. */
  freesound?: FreesoundHost;
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
  /**
   * Record what an sfx, a song or an instrument note sounds like as a new user sample, converted for the project's
   * chip (the studio's Resample button). Resolves to the new sample's metadata; rejects when it cannot be made.
   */
  resample: (ref: DocRef, opts: ResampleOptions) => Promise<SampleInfo>;
  /** The project's user samples, without their audio. */
  samples: () => Promise<SampleInfo[]>;
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
