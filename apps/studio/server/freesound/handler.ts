/* The Freesound routes, as one function from a web standard Request to a Response. Vercel Functions
   (api/freesound/[...path].ts), the Vite dev server and the CLI's studio server all call it, so the key never reaches a
   browser and every environment answers the same.

   GET /api/freesound/status           { configured }
   GET /api/freesound/search?...       a page of CC0 (optionally CC BY) "Instrument samples", see protocol.ts
   GET /api/freesound/sound/:id        one sound's details
   GET /api/freesound/preview/:id      the HQ preview MP3, from our own origin (the studio is cross-origin isolated)
   GET /api/freesound/waveform/:id     the waveform image, same reason

   Every parameter is checked against protocol.ts and nothing from the request is passed on as it came. */
import { apiKey, type FreesoundEnv, processEnv } from "./env.ts";
import {
  createLimitState,
  type LimitState,
  takeApi,
  takeIp,
} from "./limits.ts";
import {
  FREESOUND_BASE,
  type FreesoundError,
  type FreesoundErrorCode,
  type SearchResponse,
  type SoundResponse,
} from "./protocol.ts";
import {
  API_ORIGIN,
  buildSearchParams,
  CDN_HOST,
  descriptionOf,
  type MediaKind,
  mapSound,
  mediaPath,
  mediaUrlOf,
  parseQuery,
  SOUND_FIELDS,
  safeLookupUrl,
} from "./upstream.ts";

export interface HandlerDeps {
  env?: FreesoundEnv;
  fetch?: typeof fetch;
  limits?: LimitState;
  now?: () => number;
}

/* Cache-Control per kind of answer. A shared cache (Vercel's CDN) serves these without waking the function, which is
   what keeps one key enough for every visitor. Errors are never cached. */
const CACHE = {
  media: "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
  none: "no-store",
  search: "public, max-age=60, s-maxage=600, stale-while-revalidate=3600",
  sound: "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
} as const;

const API_TIMEOUT_MS = 8000;
const MEDIA_TIMEOUT_MS = 10_000;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const ID_RE = /^\d{1,12}$/;

/** Limits of the instance, shared by every request it serves. */
const instanceLimits = createLimitState();

const BASE_HEADERS = {
  // the studio is cross-origin isolated (COEP require-corp): its own origin may load these, nobody else needs to
  "cross-origin-resource-policy": "same-origin",
  "x-content-type-options": "nosniff",
};

function failure(
  status: number,
  error: FreesoundErrorCode,
  message: string,
  retryAfter?: number
): Response {
  const body: FreesoundError = {
    error,
    message,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
  return new Response(JSON.stringify(body), {
    headers: {
      ...BASE_HEADERS,
      "cache-control": CACHE.none,
      "content-type": "application/json; charset=utf-8",
      ...(retryAfter === undefined
        ? {}
        : { "retry-after": String(retryAfter) }),
    },
    status,
  });
}

function json(body: unknown, cache: string): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      ...BASE_HEADERS,
      "cache-control": cache,
      "content-type": "application/json; charset=utf-8",
    },
    status: 200,
  });
}

function clientIp(request: Request): string {
  const h = request.headers;
  const forwarded =
    h.get("x-vercel-forwarded-for") ?? h.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

interface Ctx {
  fetch: typeof fetch;
  key: string;
  limits: LimitState;
  now: () => number;
  request: Request;
}

type ApiResult =
  | { body: unknown; ok: true }
  | { ok: false; response: Response; status: number };

/** One call to the Freesound API with the key as the token. Counted against this instance's budget. */
async function apiGet(
  ctx: Ctx,
  path: string,
  params: URLSearchParams
): Promise<ApiResult> {
  const wait = takeApi(ctx.limits, ctx.now());
  if (wait > 0) {
    return {
      ok: false,
      response: failure(
        429,
        "rate-limited",
        "Freesound's request limit is used up for now. Try again in a little while.",
        wait
      ),
      status: 429,
    };
  }
  let res: Response;
  try {
    res = await ctx.fetch(`${API_ORIGIN}${path}?${params}`, {
      headers: {
        accept: "application/json",
        authorization: `Token ${ctx.key}`,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch {
    return {
      ok: false,
      response: failure(502, "upstream", "Freesound did not answer."),
      status: 502,
    };
  }
  if (res.ok) {
    try {
      return { body: await res.json(), ok: true };
    } catch {
      return {
        ok: false,
        response: failure(
          502,
          "upstream",
          "Freesound sent an unreadable answer."
        ),
        status: 502,
      };
    }
  }
  return { ok: false, response: await upstreamError(res), status: res.status };
}

/** Freesound's error as ours: its `detail` text is passed on, the request is not. */
async function upstreamError(res: Response): Promise<Response> {
  let detail = "";
  try {
    const body = (await res.json()) as { detail?: unknown };
    detail = typeof body.detail === "string" ? body.detail.slice(0, 200) : "";
  } catch {
    detail = "";
  }
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    return failure(
      429,
      "rate-limited",
      "Freesound says too many requests were made. Try again in a little while.",
      Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60
    );
  }
  if (res.status === 404) {
    return failure(404, "not-found", "Freesound has no such sound.");
  }
  if (res.status === 401 || res.status === 403) {
    return failure(
      502,
      "upstream",
      "Freesound refused the server's API key. Check FREESOUND_CLIENT_SECRET."
    );
  }
  return failure(
    502,
    "upstream",
    `Freesound answered ${res.status}${detail ? `: ${detail}` : ""}.`
  );
}

/* ---------- routes ---------- */

async function search(ctx: Ctx, url: URL): Promise<Response> {
  const query = parseQuery(url.searchParams);
  if (typeof query === "string") {
    return failure(400, "bad-request", query);
  }
  const wait = takeIp(ctx.limits, clientIp(ctx.request), "search", ctx.now());
  if (wait > 0) {
    return failure(429, "rate-limited", "Slow down a little.", wait);
  }
  const notes: string[] = [];
  let oneShotLocally = false;
  let res = await apiGet(ctx, "/apiv2/search/", buildSearchParams(query));
  if (!res.ok && res.status === 400 && query.oneShot) {
    // the docs mark single_event as filterable but show no example of the value: if Freesound rejects the filter,
    // search without it and keep the sounds the analysis marks as a single event
    oneShotLocally = true;
    notes.push(
      "Freesound did not accept the one-shot filter, so the results are filtered here instead."
    );
    res = await apiGet(
      ctx,
      "/apiv2/search/",
      buildSearchParams(query, { oneShot: false })
    );
  }
  if (!res.ok) {
    return res.response;
  }
  const body = res.body as {
    count?: unknown;
    next?: unknown;
    results?: unknown;
  };
  const raw = Array.isArray(body.results) ? body.results : [];
  const wantLicense = query.license;
  const mapped = raw.map(mapSound);
  const allowed = mapped.filter(
    (s) =>
      s !== null &&
      (wantLicense === "by" || s.license === "cc0") &&
      (!oneShotLocally || s.oneShot === true)
  );
  const results = allowed.filter((s) => s !== null);
  const out: SearchResponse = {
    count: typeof body.count === "number" ? body.count : results.length,
    dropped: mapped.filter((s) => s === null).length,
    hasMore: typeof body.next === "string" && body.next.length > 0,
    notes,
    page: query.page,
    results,
  };
  return json(out, CACHE.search);
}

async function sound(ctx: Ctx, id: string): Promise<Response> {
  if (!ID_RE.test(id)) {
    return failure(400, "bad-request", "The sound id is a number.");
  }
  const wait = takeIp(ctx.limits, clientIp(ctx.request), "sound", ctx.now());
  if (wait > 0) {
    return failure(429, "rate-limited", "Slow down a little.", wait);
  }
  const params = new URLSearchParams({ fields: `${SOUND_FIELDS},description` });
  const res = await apiGet(ctx, `/apiv2/sounds/${id}/`, params);
  if (!res.ok) {
    return res.response;
  }
  const mapped = mapSound(res.body);
  if (!mapped) {
    return failure(
      403,
      "license-not-allowed",
      "That sound is not under CC0 or CC BY, so the studio does not offer it."
    );
  }
  const out: SoundResponse = {
    description: descriptionOf(res.body),
    sound: mapped,
  };
  return json(out, CACHE.sound);
}

/** The CDN URL for a preview or image: from the `p` hint when it has the right shape, else by asking the API. */
async function mediaTarget(
  ctx: Ctx,
  kind: MediaKind,
  id: number,
  hint: string | null
): Promise<string | Response> {
  const path = mediaPath(kind, id, hint);
  if (path) {
    return `https://${CDN_HOST}/${path}`;
  }
  const res = await apiGet(
    ctx,
    `/apiv2/sounds/${id}/`,
    new URLSearchParams({ fields: "id,license,previews,images" })
  );
  if (!res.ok) {
    return res.response;
  }
  const target = safeLookupUrl(kind, id, mediaUrlOf(kind, res.body));
  return (
    target ??
    failure(404, "not-found", "Freesound has no such preview for that sound.")
  );
}

async function media(
  ctx: Ctx,
  kind: MediaKind,
  idText: string,
  url: URL
): Promise<Response> {
  if (!ID_RE.test(idText)) {
    return failure(400, "bad-request", "The sound id is a number.");
  }
  for (const key of url.searchParams.keys()) {
    if (key !== "p") {
      return failure(
        400,
        "bad-request",
        `unknown parameter "${key.slice(0, 20)}"`
      );
    }
  }
  const wait = takeIp(ctx.limits, clientIp(ctx.request), "media", ctx.now());
  if (wait > 0) {
    return failure(429, "rate-limited", "Slow down a little.", wait);
  }
  const id = Number(idText);
  const target = await mediaTarget(ctx, kind, id, url.searchParams.get("p"));
  if (target instanceof Response) {
    return target;
  }
  let up: Response;
  try {
    up = await ctx.fetch(target, {
      signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS),
    });
  } catch {
    return failure(502, "upstream", "Freesound did not answer.");
  }
  if (!up.ok) {
    return failure(
      up.status === 404 ? 404 : 502,
      up.status === 404 ? "not-found" : "upstream",
      "Freesound could not give that file."
    );
  }
  const bytes = new Uint8Array(await up.arrayBuffer());
  const limit = kind === "preview" ? MAX_PREVIEW_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length === 0 || bytes.length > limit) {
    return failure(502, "upstream", "That file is not the size expected.");
  }
  return new Response(bytes, {
    headers: {
      ...BASE_HEADERS,
      "cache-control": CACHE.media,
      "content-length": String(bytes.length),
      "content-type": kind === "preview" ? "audio/mpeg" : "image/png",
    },
    status: 200,
  });
}

/* ---------- entry ---------- */

/** What follows /api/freesound/ in the request path ("search", "sound/12"), or null for another path. */
function routeOf(url: URL): string[] | null {
  const at = url.pathname.indexOf(`${FREESOUND_BASE}/`);
  if (at < 0) {
    return null;
  }
  return url.pathname
    .slice(at + FREESOUND_BASE.length + 1)
    .split("/")
    .filter(Boolean);
}

/** Vercel passes a catch-all route's segments as an extra query parameter named after the file (`...path` for
    `[...path].ts`). The route is read from the path itself, so those are dropped before the strict parameter checks,
    which would otherwise refuse every request on Vercel. */
const ROUTER_PARAMS = ["...path", "path"] as const;

function withoutRouterParams(url: URL): URL {
  for (const key of ROUTER_PARAMS) {
    url.searchParams.delete(key);
  }
  return url;
}

export async function handleFreesound(
  request: Request,
  deps: HandlerDeps = {}
): Promise<Response> {
  const url = withoutRouterParams(new URL(request.url));
  const route = routeOf(url);
  if (!route) {
    return failure(404, "not-found", "No such Freesound route.");
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return failure(400, "bad-request", "These routes take GET.");
  }
  const key = apiKey(deps.env ?? processEnv());
  const [name, id] = route;
  if (name === "status") {
    return json({ configured: key !== null }, CACHE.none);
  }
  if (key === null) {
    return failure(
      503,
      "not-configured",
      "Freesound is not set up on this server: it needs FREESOUND_CLIENT_SECRET (the Freesound API key)."
    );
  }
  const ctx: Ctx = {
    fetch: deps.fetch ?? fetch,
    key,
    limits: deps.limits ?? instanceLimits,
    now: deps.now ?? Date.now,
    request,
  };
  if (route.length === 1 && name === "search") {
    return await search(ctx, url);
  }
  if (route.length === 2 && id !== undefined) {
    if (name === "sound") {
      return await sound(ctx, id);
    }
    if (name === "preview" || name === "waveform") {
      return await media(ctx, name, id, url);
    }
  }
  return failure(404, "not-found", "No such Freesound route.");
}
