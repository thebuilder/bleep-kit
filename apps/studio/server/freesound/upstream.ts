/* Talking to Freesound: validating what the studio asks for, turning it into the API's search parameters, and
   shrinking the answer to what the studio shows. Pure functions, no network: handler.ts does the fetching. */
import {
  FREESOUND_CATEGORY,
  type FreesoundQuery,
  type FreesoundSound,
  type LicenseChoice,
  MAX_LENGTHS,
  MAX_PAGE,
  MAX_QUERY,
  MAX_SECONDS,
  MAX_TAGS,
  PAGE_SIZE,
  SORTS,
  type SoundLicense,
  SUBCATEGORIES,
  type SubcategoryId,
} from "./protocol.ts";

export const API_ORIGIN = "https://freesound.org";
/** Where previews and waveform images are served from (their URLs come from the API's `previews` and `images`). */
export const CDN_HOST = "cdn.freesound.org";

/** Fields asked of the search and sound resources. Descriptors (`note_name` and the rest) are asked for by name. */
export const SOUND_FIELDS = [
  "id",
  "name",
  "tags",
  "username",
  "license",
  "duration",
  "previews",
  "images",
  "url",
  "subcategory",
  "num_downloads",
  "avg_rating",
  "note_name",
  "note_confidence",
  "single_event",
  "loopable",
].join(",");

/** Notes whose detection confidence (0 to 1, from the `note_confidence` descriptor) is lower are not shown. */
const NOTE_MIN_CONFIDENCE = 0.5;

/** The license strings of the `license` field, as the API docs list them. */
const LICENSE_CC0 = "Creative Commons 0";
const LICENSE_BY = "Attribution";

/* ---------- the request from the studio ---------- */

const QUERY_KEYS = new Set([
  "q",
  "sub",
  "tags",
  "license",
  "oneshot",
  "max",
  "sort",
  "page",
]);
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const QUERY_STRIP = /[^\p{L}\p{N} '._-]/gu;
const SPACES = /\s+/g;

/** Free text with everything but letters, digits, spaces and ' . _ - taken out, so it cannot add filter syntax. */
export function cleanQuery(text: string): string {
  return text
    .replace(QUERY_STRIP, " ")
    .replace(SPACES, " ")
    .trim()
    .slice(0, MAX_QUERY);
}

function readTags(raw: string | null): string[] | string {
  if (!raw) {
    return [];
  }
  const tags = [...new Set(raw.split(","))];
  if (tags.length > MAX_TAGS || tags.some((t) => !TAG_RE.test(t))) {
    return `tags: at most ${MAX_TAGS} lowercase tags made of letters, digits and dashes`;
  }
  return tags.sort();
}

const SMALL_INT = /^\d{1,3}$/;
const LICENSE_BY_URL = /\/licenses\/by\/\d/;

function readInt(raw: string | null, min: number, max: number): number | null {
  if (raw === null) {
    return min;
  }
  if (!SMALL_INT.test(raw)) {
    return null;
  }
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

function readMax(raw: string | null): number | null | string {
  if (raw === null) {
    return null;
  }
  const n = Number(raw);
  return (MAX_LENGTHS as readonly number[]).includes(n)
    ? n
    : `max: one of ${MAX_LENGTHS.join(", ")} seconds`;
}

/** The studio's search parameters, or a sentence saying what is wrong. Unknown parameters are refused. */
export function parseQuery(params: URLSearchParams): FreesoundQuery | string {
  for (const key of params.keys()) {
    if (!QUERY_KEYS.has(key)) {
      return `unknown parameter "${key.slice(0, 20)}"`;
    }
  }
  const sub = params.get("sub");
  if (sub !== null && !SUBCATEGORIES.some((s) => s.id === sub)) {
    return `sub: one of ${SUBCATEGORIES.map((s) => s.id).join(", ")}`;
  }
  const sort = params.get("sort") ?? "relevance";
  if (!SORTS.some((s) => s.id === sort)) {
    return `sort: one of ${SORTS.map((s) => s.id).join(", ")}`;
  }
  const license = params.get("license") ?? "cc0";
  if (license !== "cc0" && license !== "by") {
    return "license: cc0 or by";
  }
  const oneshot = params.get("oneshot");
  if (oneshot !== null && oneshot !== "1") {
    return "oneshot: 1 or leave it out";
  }
  const tags = readTags(params.get("tags"));
  const maxSeconds = readMax(params.get("max"));
  const page = readInt(params.get("page"), 1, MAX_PAGE);
  if (typeof tags === "string") {
    return tags;
  }
  if (typeof maxSeconds === "string") {
    return maxSeconds;
  }
  if (page === null) {
    return `page: a number from 1 to ${MAX_PAGE}`;
  }
  return {
    license: license as LicenseChoice,
    maxSeconds,
    oneShot: oneshot === "1",
    page,
    q: cleanQuery(params.get("q") ?? ""),
    sort: sort as FreesoundQuery["sort"],
    sub: sub as SubcategoryId | null,
    tags,
  };
}

/* ---------- the request to Freesound ---------- */

const quote = (text: string): string => `"${text.replaceAll('"', "")}"`;

/** The `filter` of the search: one clause per limit, separated by spaces. */
export function buildFilter(
  query: FreesoundQuery,
  opts: { oneShot?: boolean } = {}
): string {
  const parts = [`category:${quote(FREESOUND_CATEGORY)}`];
  const sub = SUBCATEGORIES.find((s) => s.id === query.sub);
  if (sub) {
    parts.push(`subcategory:${quote(sub.name)}`);
  }
  parts.push(
    query.license === "by"
      ? `license:(${quote(LICENSE_CC0)} OR ${quote(LICENSE_BY)})`
      : `license:${quote(LICENSE_CC0)}`
  );
  if (query.tags.length > 0) {
    parts.push(`tag:(${query.tags.map(quote).join(" AND ")})`);
  }
  parts.push(`duration:[0 TO ${query.maxSeconds ?? MAX_SECONDS}]`);
  if (query.oneShot && (opts.oneShot ?? true)) {
    parts.push("single_event:true");
  }
  if (query.sort === "rating") {
    // a single five star vote should not top the list
    parts.push("num_ratings:[3 TO *]");
  }
  return parts.join(" ");
}

/** The parameters of `GET /apiv2/search/`. */
export function buildSearchParams(
  query: FreesoundQuery,
  opts: { oneShot?: boolean } = {}
): URLSearchParams {
  const sort = SORTS.find((s) => s.id === query.sort)?.upstream ?? "score";
  const p = new URLSearchParams();
  p.set("query", query.q);
  p.set("filter", buildFilter(query, opts));
  p.set("sort", sort);
  p.set("fields", SOUND_FIELDS);
  p.set("page", String(query.page));
  p.set("page_size", String(PAGE_SIZE));
  return p;
}

/* ---------- the answer ---------- */

type Raw = Record<string, unknown>;
const isRaw = (v: unknown): v is Raw =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown): boolean | null =>
  typeof v === "boolean" ? v : null;

/** CC0 or CC BY; anything else (NonCommercial, Sampling+, a license we do not know) is refused. */
export function licenseOf(value: unknown): SoundLicense | null {
  const text = str(value);
  if (text === LICENSE_CC0 || text.includes("/publicdomain/zero/")) {
    return "cc0";
  }
  if (text === LICENSE_BY || LICENSE_BY_URL.test(text)) {
    return "by";
  }
  return null;
}

const MEDIA_FILE = "[A-Za-z0-9_-]{1,60}";

export type MediaKind = "preview" | "waveform";

/** The path pattern of a preview or waveform on the CDN, with the sound id captured. */
function mediaRe(kind: MediaKind): RegExp {
  return kind === "preview"
    ? new RegExp(`^previews/\\d{1,6}/(\\d{1,12})_${MEDIA_FILE}\\.mp3$`)
    : new RegExp(`^displays/\\d{1,6}/(\\d{1,12})_${MEDIA_FILE}\\.png$`);
}

/** A CDN path that is allowed for sound `id`, or null. Used for the `p` hint of the media routes. */
export function mediaPath(
  kind: MediaKind,
  id: number,
  path: string | null
): string | null {
  const m = path === null ? null : mediaRe(kind).exec(path);
  return m && Number(m[1]) === id ? (path as string) : null;
}

/** The CDN path inside an API preview or image URL, when it points at the CDN and has the expected shape. */
function pathFromUrl(
  kind: MediaKind,
  id: number,
  value: unknown
): string | null {
  try {
    const url = new URL(str(value));
    if (url.protocol !== "https:" || url.hostname !== CDN_HOST) {
      return null;
    }
    return mediaPath(kind, id, url.pathname.slice(1));
  } catch {
    return null;
  }
}

function pageUrl(raw: unknown, id: number): string {
  const url = str(raw);
  return url.startsWith(`${API_ORIGIN}/`) ? url : `${API_ORIGIN}/s/${id}/`;
}

/** Note names such as "A4" or "E#7"; anything else is not shown. */
const NOTE_SHOWN = /^[A-G][#b]?-?\d$/;

function noteOf(raw: Raw): string | null {
  const name = str(raw.note_name);
  const confidence = num(raw.note_confidence);
  if (!NOTE_SHOWN.test(name)) {
    return null;
  }
  return confidence !== null && confidence < NOTE_MIN_CONFIDENCE ? null : name;
}

/** One sound of an API answer, shrunk. Null when it is malformed or its license is not CC0 or CC BY. */
export function mapSound(value: unknown): FreesoundSound | null {
  if (!isRaw(value)) {
    return null;
  }
  const id = num(value.id);
  const license = licenseOf(value.license);
  const duration = num(value.duration);
  if (id === null || !Number.isInteger(id) || id < 1 || license === null) {
    return null;
  }
  const previews = isRaw(value.previews) ? value.previews : {};
  const images = isRaw(value.images) ? value.images : {};
  const tags = Array.isArray(value.tags)
    ? value.tags.filter((t): t is string => typeof t === "string").slice(0, 12)
    : [];
  return {
    author: str(value.username).slice(0, 64),
    downloads: num(value.num_downloads) ?? 0,
    duration: duration ?? 0,
    id,
    license,
    loopable: bool(value.loopable),
    name: str(value.name).slice(0, 128) || `Sound ${id}`,
    note: noteOf(value),
    oneShot: bool(value.single_event),
    pv: pathFromUrl("preview", id, previews["preview-hq-mp3"]),
    rating: (num(value.avg_rating) ?? 0) > 0 ? num(value.avg_rating) : null,
    subcategory: str(value.subcategory) || null,
    tags,
    url: pageUrl(value.url, id),
    wf: pathFromUrl("waveform", id, images.waveform_m),
  };
}

/** The `description` of a sound resource, cut short. */
export function descriptionOf(value: unknown): string {
  return isRaw(value) ? str(value.description).slice(0, 400) : "";
}

/** The full URL of a preview or image in an API sound resource, for the media routes' lookup. */
export function mediaUrlOf(kind: MediaKind, value: unknown): string | null {
  if (!isRaw(value)) {
    return null;
  }
  const source = kind === "preview" ? value.previews : value.images;
  const url = isRaw(source)
    ? source[kind === "preview" ? "preview-hq-mp3" : "waveform_m"]
    : null;
  return typeof url === "string" ? url : null;
}

const LOOKUP_HOSTS = new Set([CDN_HOST, "freesound.org"]);

/**
 * The URL to fetch for a preview or image when the API had to be asked (no usable `p` hint): https, one of Freesound's
 * own hosts and a path of the expected kind for this sound, or null.
 */
export function safeLookupUrl(
  kind: MediaKind,
  id: number,
  value: unknown
): string | null {
  try {
    const url = new URL(str(value));
    const ext = kind === "preview" ? "mp3" : "png";
    const dir = kind === "preview" ? "previews" : "displays";
    const path = new RegExp(
      `^/(?:data/)?${dir}/\\d{1,6}/${id}_${MEDIA_FILE}\\.${ext}$`
    );
    return url.protocol === "https:" &&
      LOOKUP_HOSTS.has(url.hostname) &&
      path.test(url.pathname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}
