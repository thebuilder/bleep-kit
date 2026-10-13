/* The studio's side of the Freesound routes (server/freesound): typed calls over fetch, and the failures a person can
   act on told apart: the server has no API key, there is no server at all (a static preview), or a limit was hit. The
   key itself never gets here. */
import {
  FREESOUND_BASE,
  type FreesoundError,
  type FreesoundQuery,
  type FreesoundSound,
  queryToParams,
  type SearchResponse,
} from "../../server/freesound/protocol.ts";

export type FailureKind =
  | "not-configured"
  | "unavailable"
  | "rate-limited"
  | "failed";

/** Why a Freesound call did not work, in words for the person. */
export class FreesoundFailure extends Error {
  readonly kind: FailureKind;
  /** Seconds to wait, for "rate-limited". */
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    options: {
      cause?: unknown;
      kind: FailureKind;
      retryAfter?: number | undefined;
    }
  ) {
    super(message, { cause: options.cause });
    this.kind = options.kind;
    this.retryAfter = options.retryAfter;
  }
}

const UNAVAILABLE =
  "The Freesound browser needs the studio's server. Use the deployed studio, or run pnpm dev with FREESOUND_CLIENT_SECRET in .env.local.";

async function readError(res: Response): Promise<FreesoundFailure> {
  let body: Partial<FreesoundError> | null = null;
  try {
    body = (await res.json()) as Partial<FreesoundError>;
  } catch {
    body = null;
  }
  if (!body?.error) {
    // an HTML 404 from a static host, not one of our answers
    const missing = res.status === 404 || res.status === 405;
    return new FreesoundFailure(
      missing ? UNAVAILABLE : `Freesound answered ${res.status}.`,
      { kind: missing ? "unavailable" : "failed" }
    );
  }
  const message = body.message ?? "Freesound did not work.";
  if (body.error === "not-configured") {
    return new FreesoundFailure(message, { kind: "not-configured" });
  }
  if (body.error === "rate-limited") {
    return new FreesoundFailure(message, {
      kind: "rate-limited",
      retryAfter: body.retryAfter,
    });
  }
  return new FreesoundFailure(message, { kind: "failed" });
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, signal ? { signal } : {});
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new FreesoundFailure(
      "Could not reach the studio's server. Check the connection and try again.",
      { cause: error, kind: "unavailable" }
    );
  }
  if (!res.ok) {
    throw await readError(res);
  }
  return (await res.json()) as T;
}

/** Searches already made in this visit, so going back to a filter costs nothing. */
const searches = new Map<string, SearchResponse>();
const MAX_SEARCHES = 60;

export async function searchSounds(
  query: FreesoundQuery,
  signal?: AbortSignal
): Promise<SearchResponse> {
  const key = queryToParams(query).toString();
  const known = searches.get(key);
  if (known) {
    return known;
  }
  const out = await getJson<SearchResponse>(
    `${FREESOUND_BASE}/search${key ? `?${key}` : ""}`,
    signal
  );
  searches.set(key, out);
  if (searches.size > MAX_SEARCHES) {
    searches.delete(searches.keys().next().value as string);
  }
  return out;
}

/** Where the HQ preview MP3 of a sound is served from (the studio's own origin). Every route is one path segment with
    the id in the query: Vercel's catch-all function file only receives single-segment paths. */
function previewUrl(sound: Pick<FreesoundSound, "id" | "pv">): string {
  const hint = sound.pv ? `&p=${encodeURIComponent(sound.pv)}` : "";
  return `${FREESOUND_BASE}/preview?id=${sound.id}${hint}`;
}

/** The small waveform image of a sound. */
export function waveformUrl(sound: Pick<FreesoundSound, "id" | "wf">): string {
  const hint = sound.wf ? `&p=${encodeURIComponent(sound.wf)}` : "";
  return `${FREESOUND_BASE}/waveform?id=${sound.id}${hint}`;
}

/** The preview's bytes. */
export async function fetchPreviewBytes(
  sound: Pick<FreesoundSound, "id" | "pv">,
  signal?: AbortSignal
): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetch(previewUrl(sound), signal ? { signal } : {});
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw error;
    }
    throw new FreesoundFailure("Could not load the preview.", {
      cause: error,
      kind: "unavailable",
    });
  }
  if (!res.ok) {
    throw await readError(res);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function clearSearchCache(): void {
  searches.clear();
}

export type { FreesoundSound } from "../../server/freesound/protocol.ts";
