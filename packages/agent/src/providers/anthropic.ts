// Anthropic Messages API, called straight from the browser.
//   POST https://api.anthropic.com/v1/messages  (stream: true, server-sent events)
//   GET  https://api.anthropic.com/v1/models    (the key's models, with capabilities)
// A browser may only call it when the request carries `anthropic-dangerous-direct-browser-access: true`; without it
// the API answers the CORS preflight without allowing the call. The key goes in `x-api-key`. The event shapes
// (message_start, content_block_start/delta/stop, message_delta, message_stop, ping, error) and the tool_use /
// tool_result blocks follow platform.claude.com/docs/en/build-with-claude/streaming and .../tool-use.
import { AgentError, type AgentErrorKind } from "../errors.ts";
import { readSse } from "../sse.ts";
import type {
  Block,
  Message,
  ModelInfo,
  Provider,
  ProviderOptions,
  ProviderReply,
  ProviderRequest,
  StopReason,
  ToolResultBlock,
  ToolSpec,
} from "../types.ts";
import { type Endpoint, endpoint, send, streamFailure } from "./http.ts";

const ANTHROPIC_BASE = "https://api.anthropic.com";
export const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 8192;
const MODELS_PAGE = 100;
const MODELS_PAGES = 5;

type Json = Record<string, unknown>;

/** The headers every call carries, key included. Exported for the request-shape tests. */
export function anthropicHeaders(apiKey: string): Record<string, string> {
  return {
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
    "x-api-key": apiKey,
  };
}

function resultContent(r: ToolResultBlock): string | Json[] {
  if (r.images.length === 0) {
    return r.text;
  }
  return [
    { text: r.text, type: "text" },
    ...r.images.flatMap((img) => [
      { text: img.label, type: "text" },
      {
        source: { data: img.data, media_type: img.mime, type: "base64" },
        type: "image",
      },
    ]),
  ];
}

function userContent(m: Message): Json[] {
  // tool_result blocks must come first in a user message, any text after them
  const results = m.blocks.filter(
    (b): b is ToolResultBlock => b.type === "tool_result"
  );
  const rest: Json[] = [];
  for (const b of m.blocks) {
    if (b.type === "text") {
      rest.push({ text: b.text, type: "text" });
    } else if (b.type === "image") {
      rest.push(
        { text: b.label, type: "text" },
        {
          source: { data: b.data, media_type: b.mime, type: "base64" },
          type: "image",
        }
      );
    }
  }
  return [
    ...results.map((r) => ({
      content: resultContent(r),
      ...(r.isError ? { is_error: true } : {}),
      tool_use_id: r.callId,
      type: "tool_result",
    })),
    ...rest,
  ];
}

function assistantContent(m: Message): Json[] {
  const out: Json[] = [];
  for (const b of m.blocks) {
    if (b.type === "text" && b.text) {
      out.push({ text: b.text, type: "text" });
    } else if (b.type === "tool_call") {
      out.push({
        id: b.id,
        input: b.input ?? {},
        name: b.name,
        type: "tool_use",
      });
    } else if (b.type === "opaque" && b.provider === "anthropic") {
      out.push(b.data as Json);
    }
  }
  return out;
}

/** The provider neutral messages as the Messages API wants them. Exported for the request-shape tests. */
function toWireMessages(messages: readonly Message[]): Json[] {
  return messages
    .map((m) => ({
      content: m.role === "user" ? userContent(m) : assistantContent(m),
      role: m.role,
    }))
    .filter((m) => m.content.length > 0);
}

function toWireTools(tools: readonly ToolSpec[]): Json[] {
  return tools.map((t) => ({
    description: t.description,
    input_schema: t.inputSchema,
    name: t.name,
  }));
}

/** The request body. Exported for the request-shape tests. */
export function buildAnthropicBody(req: ProviderRequest): Json {
  return {
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages: toWireMessages(req.messages),
    model: req.model,
    stream: true,
    // The system prompt and the tools are part of what every thinking block's signature is bound to, so both are the
    // same for the whole conversation (what changes per turn rides in the user message). The first part is cached.
    system: req.system.map((text, i) => ({
      text,
      type: "text",
      ...(i === 0 ? { cache_control: { type: "ephemeral" } } : {}),
    })),
    tools: toWireTools(req.tools),
  };
}

const STOP: Record<string, StopReason> = {
  end_turn: "end",
  max_tokens: "max_tokens",
  stop_sequence: "end",
  tool_use: "tool_use",
};

const ERROR_KIND: Record<string, AgentErrorKind> = {
  api_error: "server",
  authentication_error: "auth",
  invalid_request_error: "bad_request",
  not_found_error: "bad_request",
  overloaded_error: "overloaded",
  permission_error: "forbidden",
  rate_limit_error: "rate_limit",
  request_too_large: "bad_request",
};

interface Building {
  json: string;
  raw: Json;
}

/** Accumulates the content blocks of one streamed message. */
class MessageBuilder {
  private readonly blocks = new Map<number, Building>();
  stop: StopReason = "end";
  usage = { input: 0, output: 0 };
  private readonly onText: (delta: string) => void;

  constructor(onText: (delta: string) => void) {
    this.onText = onText;
  }

  event(type: string, e: Json): void {
    const index = typeof e.index === "number" ? e.index : -1;
    if (type === "message_start") {
      const u = (e.message as Json | undefined)?.usage as Json | undefined;
      this.usage.input = Number(u?.input_tokens ?? 0);
    } else if (type === "content_block_start") {
      const raw = structuredClone(e.content_block as Json);
      this.blocks.set(index, { json: "", raw });
    } else if (type === "content_block_delta") {
      this.delta(index, e.delta as Json);
    } else if (type === "message_delta") {
      const d = e.delta as Json | undefined;
      this.stop = STOP[String(d?.stop_reason ?? "end_turn")] ?? "other";
      this.usage.output = Number(
        (e.usage as Json | undefined)?.output_tokens ?? this.usage.output
      );
    }
  }

  private delta(index: number, d: Json): void {
    const b = this.blocks.get(index);
    if (!b) {
      return;
    }
    switch (d.type) {
      case "text_delta":
        b.raw.text = `${String(b.raw.text ?? "")}${String(d.text)}`;
        this.onText(String(d.text));
        break;
      case "input_json_delta":
        b.json += String(d.partial_json ?? "");
        break;
      case "thinking_delta":
        b.raw.thinking = `${String(b.raw.thinking ?? "")}${String(d.thinking)}`;
        break;
      case "signature_delta":
        b.raw.signature = String(d.signature);
        break;
      default:
        break;
    }
  }

  blocksInOrder(): Block[] {
    const out: Block[] = [];
    for (const [, b] of [...this.blocks.entries()].sort(
      (x, y) => x[0] - y[0]
    )) {
      const { raw } = b;
      if (raw.type === "text") {
        if (String(raw.text ?? "") !== "") {
          out.push({ text: String(raw.text), type: "text" });
        }
      } else if (raw.type === "tool_use") {
        out.push({
          id: String(raw.id),
          input: this.parseInput(b),
          name: String(raw.name),
          type: "tool_call",
        });
      } else {
        out.push({ data: raw, provider: "anthropic", type: "opaque" });
      }
    }
    return out;
  }

  private parseInput(b: Building): unknown {
    if (b.json.trim() === "") {
      return {};
    }
    try {
      return JSON.parse(b.json);
    } catch (cause) {
      throw new AgentError("stream", {
        cause,
        detail: `The arguments of the ${String(b.raw.name)} call were cut off${this.stop === "max_tokens" ? " (the reply hit its length limit)" : ""}.`,
        provider: "anthropic",
      });
    }
  }
}

function throwStreamError(e: Json): never {
  const err = e.error as Json | undefined;
  const type = String(err?.type ?? "");
  throw new AgentError(ERROR_KIND[type] ?? "unknown", {
    detail: String(err?.message ?? "the stream reported an error"),
    provider: "anthropic",
  });
}

const STALE_THINKING_RE =
  /invalid `?signature`? in `?(?:redacted_)?thinking`? block|bound to a different conversation/i;

/**
 * Newer models bind each thinking block's signature to the conversation before it (system prompt, tools, every earlier
 * message). When the API says a replayed block no longer matches, the error is flagged so the loop can drop the
 * thinking blocks from the history and retry, which is the recovery the docs give; asking the API to drop them itself
 * (`thinking.block_binding.prefix_mismatch_behavior`) is a beta setting the docs call a stopgap.
 */
function flagStaleThinking(error: unknown): unknown {
  if (
    error instanceof AgentError &&
    error.kind === "bad_request" &&
    STALE_THINKING_RE.test(error.detail ?? "")
  ) {
    return new AgentError(error.kind, {
      cause: error,
      provider: "anthropic",
      staleThinking: true,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
      ...(error.status === undefined ? {} : { status: error.status }),
    });
  }
  return error;
}

async function complete(
  ep: Endpoint,
  apiKey: string,
  req: ProviderRequest,
  onText: (delta: string) => void
): Promise<ProviderReply> {
  const res = await send(ep, "/v1/messages", {
    body: JSON.stringify(buildAnthropicBody(req)),
    headers: anthropicHeaders(apiKey),
    method: "POST",
    ...(req.signal ? { signal: req.signal } : {}),
  }).catch((error: unknown) => {
    throw flagStaleThinking(error);
  });
  if (!res.body) {
    throw new AgentError("stream", { provider: "anthropic" });
  }
  const builder = new MessageBuilder(onText);
  let finished = false;
  try {
    for await (const ev of readSse(res.body)) {
      if (ev.data === "") {
        continue;
      }
      const data = JSON.parse(ev.data) as Json;
      const type = String(data.type ?? ev.event ?? "");
      if (type === "error") {
        throwStreamError(data);
      }
      if (type === "message_stop") {
        finished = true;
      }
      builder.event(type, data);
    }
  } catch (error) {
    throw streamFailure(error, ep, req.signal);
  }
  if (!finished) {
    throw new AgentError("stream", { provider: "anthropic" });
  }
  return {
    blocks: builder.blocksInOrder(),
    stop: builder.stop,
    usage: builder.usage,
  };
}

interface WireModel {
  capabilities?: { image_input?: { supported?: boolean } } | null;
  created_at?: string;
  display_name?: string;
  id: string;
  lifecycle?: string;
  max_tokens?: number | null;
}

function toModel(m: WireModel): ModelInfo {
  const created = m.created_at ? Date.parse(m.created_at) / 1000 : Number.NaN;
  return {
    created: Number.isFinite(created) ? created : null,
    id: m.id,
    images: m.capabilities?.image_input?.supported ?? null,
    maxOutput: m.max_tokens ? m.max_tokens : null,
    name: m.display_name || m.id,
  };
}

interface ModelsPage {
  data?: WireModel[];
  has_more?: boolean;
  last_id?: string;
}

async function modelsPage(
  ep: Endpoint,
  apiKey: string,
  after: string | null,
  signal?: AbortSignal
): Promise<ModelsPage> {
  const query = `limit=${MODELS_PAGE}${after ? `&after_id=${encodeURIComponent(after)}` : ""}`;
  const res = await send(ep, `/v1/models?${query}`, {
    headers: anthropicHeaders(apiKey),
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  return (await res.json()) as ModelsPage;
}

async function listModels(
  ep: Endpoint,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let after: string | null = null;
  for (let page = 0; page < MODELS_PAGES; page += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each page's cursor comes from the one before
    const body = await modelsPage(ep, apiKey, after, signal);
    out.push(
      ...(body.data ?? []).filter((m) => m.lifecycle !== "retired").map(toModel)
    );
    if (!(body.has_more && body.last_id)) {
      break;
    }
    after = body.last_id;
  }
  return out.sort((x, y) => (y.created ?? 0) - (x.created ?? 0));
}

export function createAnthropic(opts: ProviderOptions): Provider {
  const ep = endpoint("anthropic", ANTHROPIC_BASE, opts);
  return {
    complete: (req, onText) => complete(ep, opts.apiKey, req, onText),
    id: "anthropic",
    listModels: (signal) => listModels(ep, opts.apiKey, signal),
  };
}
