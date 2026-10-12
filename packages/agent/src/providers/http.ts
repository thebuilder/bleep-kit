// The one place a request leaves the browser. Turns every way a call can fail into an AgentError with the right kind,
// and never puts the key into a message.
import { AgentError, kindForStatus } from "../errors.ts";
import type { ProviderId, ProviderOptions } from "../types.ts";

export interface Endpoint {
  baseUrl: string;
  fetch: typeof fetch;
  id: ProviderId;
}

const TRAILING_SLASHES = /\/+$/;

export function endpoint(
  id: ProviderId,
  defaultBase: string,
  opts: ProviderOptions
): Endpoint {
  return {
    baseUrl: (opts.baseUrl ?? defaultBase).replace(TRAILING_SLASHES, ""),
    fetch: opts.fetch ?? ((input, init) => globalThis.fetch(input, init)),
    id,
  };
}

/** Pull a message out of the JSON error bodies both providers send (`{error: {message}}`), else the plain text. */
async function errorDetail(res: Response): Promise<string | undefined> {
  const text = await res.text().catch(() => "");
  if (!text) {
    return;
  }
  try {
    const body = JSON.parse(text) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const e = body.error;
    const message = typeof e === "string" ? e : (e?.message ?? body.message);
    if (typeof message === "string" && message) {
      return message;
    }
  } catch {
    // not JSON: use the text below
  }
  return text.slice(0, 300);
}

const isAbort = (error: unknown): boolean =>
  error instanceof Error && error.name === "AbortError";

/** fetch, with failures turned into AgentError. A non-2xx answer throws; a 2xx answer is returned. */
export async function send(
  ep: Endpoint,
  path: string,
  init: RequestInit
): Promise<Response> {
  let res: Response;
  try {
    res = await ep.fetch(`${ep.baseUrl}${path}`, init);
  } catch (error) {
    if (isAbort(error) || init.signal?.aborted) {
      throw new AgentError("aborted", { cause: error, provider: ep.id });
    }
    throw new AgentError("network", { cause: error, provider: ep.id });
  }
  if (res.ok) {
    return res;
  }
  const retry = Number(res.headers.get("retry-after"));
  const detail = await errorDetail(res);
  throw new AgentError(kindForStatus(res.status), {
    provider: ep.id,
    status: res.status,
    ...(detail === undefined ? {} : { detail }),
    ...(Number.isFinite(retry) && retry > 0 ? { retryAfter: retry } : {}),
  });
}

/** Rethrow whatever broke while a stream was being read as an AgentError. */
export function streamFailure(
  error: unknown,
  ep: Endpoint,
  signal?: AbortSignal
): AgentError {
  if (error instanceof AgentError) {
    return error;
  }
  if (isAbort(error) || signal?.aborted) {
    return new AgentError("aborted", { provider: ep.id });
  }
  return new AgentError("stream", { provider: ep.id });
}
