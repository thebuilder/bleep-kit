// Errors the agent raises, with the words a person should read for each. Providers throw AgentError; the loop turns
// anything else into one so the studio only ever shows `explain(error)`.
import type { ProviderId } from "./types.ts";

export type AgentErrorKind =
  | "auth" // 401: the key was not accepted
  | "forbidden" // 403: the key may not use this
  | "rate_limit" // 429
  | "overloaded" // 529 or a 5xx that says so
  | "server" // 5xx
  | "bad_request" // 400, 404, 413, 422
  | "network" // fetch itself failed: offline, blocked, or CORS
  | "stream" // the stream broke or ended early
  | "aborted"
  | "unknown";

export interface AgentErrorInit {
  /** The error that caused this one, kept for debugging. */
  cause?: unknown;
  /** What the provider said, trimmed. */
  detail?: string;
  provider?: ProviderId;
  retryAfter?: number;
  status?: number;
}

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly detail: string | undefined;
  readonly provider: ProviderId | undefined;
  readonly retryAfter: number | undefined;
  readonly status: number | undefined;

  constructor(kind: AgentErrorKind, init: AgentErrorInit = {}) {
    super(
      init.detail ?? kind,
      init.cause === undefined ? undefined : { cause: init.cause }
    );
    this.name = "AgentError";
    this.kind = kind;
    this.detail = init.detail;
    this.provider = init.provider;
    this.retryAfter = init.retryAfter;
    this.status = init.status;
  }
}

const PROVIDER_NAME: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};
const PROVIDER_HOST: Record<ProviderId, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
};

export const providerName = (id: ProviderId | undefined): string =>
  id ? PROVIDER_NAME[id] : "the provider";

/** The error kind for an HTTP status. */
export function kindForStatus(status: number): AgentErrorKind {
  if (status === 401) {
    return "auth";
  }
  if (status === 403) {
    return "forbidden";
  }
  if (status === 429) {
    return "rate_limit";
  }
  if (status === 529) {
    return "overloaded";
  }
  if (status >= 500) {
    return "server";
  }
  return status >= 400 ? "bad_request" : "unknown";
}

const WHITESPACE_RE = /\s+/g;

function trimDetail(detail: string | undefined): string {
  if (!detail) {
    return "";
  }
  const one = detail.replace(WHITESPACE_RE, " ").trim();
  return one.length > 240 ? `${one.slice(0, 237)}...` : one;
}

type Say = (e: AgentError, who: string, detail: string) => string;

const retryText = (e: AgentError): string =>
  e.retryAfter
    ? `, try again in about ${Math.ceil(e.retryAfter)} seconds`
    : ", wait a moment and try again";

const WORDS: Record<AgentErrorKind, Say> = {
  aborted: () => "Stopped.",
  auth: (_e, who) =>
    `${who} did not accept this API key (401). Check that it is complete and still active, or paste a new one in the assistant settings.`,
  bad_request: (e, who, detail) =>
    `${who} refused the request${e.status ? ` (${e.status})` : ""}${detail ? `: ${detail}` : "."}`,
  forbidden: (_e, who, detail) =>
    `${who} says this key is not allowed to do that (403). The key may lack access to the model or the project it belongs to.${detail ? ` ${detail}` : ""}`,
  network: (e) =>
    `Could not reach ${e.provider ? PROVIDER_HOST[e.provider] : "the provider"}. Check your connection. If you are online, a browser extension, a VPN or a network filter may be blocking the request (the browser reports a blocked cross-origin call the same way).`,
  overloaded: (_e, who) =>
    `${who} is overloaded right now. Try again in a minute.`,
  rate_limit: (e, who) =>
    `${who} is rate limiting this key (429)${retryText(e)}. If it keeps happening, check the usage limits or credit balance of the account.`,
  server: (e, who, detail) =>
    `${who} had a server error (${e.status ?? "5xx"}). Try again in a minute.${detail ? ` ${detail}` : ""}`,
  stream: (_e, who, detail) =>
    `The reply from ${who} was cut off before it finished.${detail ? ` ${detail}` : ""} Try again.`,
  unknown: (_e, _who, detail) =>
    `Something went wrong${detail ? `: ${detail}` : "."}`,
};

/** Plain words for an error, ready to show in the panel. Never contains the key. */
export function explain(error: unknown): string {
  if (!(error instanceof AgentError)) {
    return `Something went wrong: ${trimDetail(error instanceof Error ? error.message : String(error))}`;
  }
  return WORDS[error.kind](
    error,
    providerName(error.provider),
    trimDetail(error.detail)
  );
}
