/* The Freesound browser's wire format, shared by the server function (server/freesound/handler.ts) and the studio's
   client (src/freesound). Everything a request may contain is listed here: the handler refuses the rest. The names on
   the Freesound side (fields, filters, sort values, license strings) come from https://freesound.org/docs/api/. */

/** Our routes live under this path, on the studio's own origin. */
export const FREESOUND_BASE = "/api/freesound";

/** Top-level category of the Broad Sound Taxonomy that the browser is limited to. */
export const FREESOUND_CATEGORY = "Instrument samples";

/** The second-level classes of "Instrument samples" (https://freesound.org/help/broad-sound-taxonomy/). */
export const SUBCATEGORIES = [
  { id: "percussion", label: "Percussion", name: "Percussion" },
  { id: "string", label: "Strings", name: "String" },
  { id: "wind", label: "Wind", name: "Wind" },
  { id: "keys", label: "Keys", name: "Piano / Keyboard instruments" },
  { id: "synth", label: "Synths", name: "Synths / Electronic" },
  { id: "other", label: "Other", name: "Other" },
] as const;

export type SubcategoryId = (typeof SUBCATEGORIES)[number]["id"];

export const SORTS = [
  { id: "relevance", label: "Relevance", upstream: "score" },
  { id: "shortest", label: "Shortest first", upstream: "duration_asc" },
  { id: "rating", label: "Top rated", upstream: "rating_desc" },
  { id: "downloads", label: "Most downloaded", upstream: "downloads_desc" },
] as const;

export type SortId = (typeof SORTS)[number]["id"];

/** Longest sound the browser asks for, in seconds: a preview must fit a sample (2 MiB of 16 bit audio at 48 kHz). */
export const MAX_SECONDS = 20;

/** The "Max length" choices, in seconds. */
export const MAX_LENGTHS = [0.5, 1, 2, 5] as const;

/** `cc0`: Creative Commons 0 only. `by`: also CC BY (credit required). Nothing else is ever offered. */
export type LicenseChoice = "cc0" | "by";

/** License of a result: the two a game can ship. */
export type SoundLicense = "cc0" | "by";

export const PAGE_SIZE = 24;
export const MAX_PAGE = 40;
export const MAX_TAGS = 4;
export const MAX_QUERY = 80;

export interface FreesoundQuery {
  license: LicenseChoice;
  /** Seconds, one of MAX_LENGTHS, or null for up to MAX_SECONDS. */
  maxSeconds: number | null;
  /** Only sounds Freesound's analysis calls a single event. */
  oneShot: boolean;
  /** 1 based. */
  page: number;
  /** Free text. */
  q: string;
  sort: SortId;
  /** A subcategory id, or null for the whole category. */
  sub: SubcategoryId | null;
  /** Tags that must all be present. */
  tags: string[];
}

export const DEFAULT_QUERY: FreesoundQuery = {
  license: "cc0",
  maxSeconds: null,
  oneShot: false,
  page: 1,
  q: "",
  sort: "relevance",
  sub: "percussion",
  tags: [],
};

/** One sound as the studio shows it. */
export interface FreesoundSound {
  author: string;
  /** Downloads on Freesound (a popularity hint). */
  downloads: number;
  /** Seconds. */
  duration: number;
  id: number;
  license: SoundLicense;
  /** Freesound's `loopable` descriptor, when analysed. */
  loopable: boolean | null;
  name: string;
  /** Detected note such as "A4" (Freesound's `note_name`), when analysed with enough confidence. */
  note: string | null;
  /** Freesound's `single_event` descriptor, when analysed. */
  oneShot: boolean | null;
  /** Path hint for the preview route (`?p=`), or null when the route has to look the sound up. */
  pv: string | null;
  /** Average rating 0 to 5, or null when nobody rated it. */
  rating: number | null;
  subcategory: string | null;
  tags: string[];
  /** The sound's page on freesound.org. */
  url: string;
  /** Path hint for the waveform route. */
  wf: string | null;
}

export interface SearchResponse {
  count: number;
  /** Results the license check removed (anything that is not CC0 or CC BY). */
  dropped: number;
  hasMore: boolean;
  /** Things the studio should tell the person, such as a filter Freesound did not accept. */
  notes: string[];
  page: number;
  results: FreesoundSound[];
}

export interface SoundResponse {
  description: string;
  sound: FreesoundSound;
}

export type FreesoundErrorCode =
  | "bad-request"
  | "license-not-allowed"
  | "not-configured"
  | "not-found"
  | "rate-limited"
  | "upstream";

export interface FreesoundError {
  error: FreesoundErrorCode;
  message: string;
  /** Seconds, when the caller should wait. */
  retryAfter?: number;
}

/** The query as URL parameters, in one fixed order so equal searches share one cache entry. */
export function queryToParams(query: FreesoundQuery): URLSearchParams {
  const p = new URLSearchParams();
  const q = query.q.trim();
  if (q) {
    p.set("q", q);
  }
  if (query.sub) {
    p.set("sub", query.sub);
  }
  if (query.tags.length > 0) {
    p.set("tags", [...query.tags].sort().join(","));
  }
  if (query.license !== "cc0") {
    p.set("license", query.license);
  }
  if (query.oneShot) {
    p.set("oneshot", "1");
  }
  if (query.maxSeconds !== null) {
    p.set("max", String(query.maxSeconds));
  }
  if (query.sort !== "relevance") {
    p.set("sort", query.sort);
  }
  if (query.page > 1) {
    p.set("page", String(query.page));
  }
  return p;
}
