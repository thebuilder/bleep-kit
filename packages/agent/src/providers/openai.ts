// OpenAI Responses API, called straight from the browser.
//   POST https://api.openai.com/v1/responses  (stream: true, server-sent events)
//   GET  https://api.openai.com/v1/models     (the key's models; no capability fields)
// The Responses API is OpenAI's recommended API for new work with tools (function calling, reasoning models). The key
// goes in `Authorization: Bearer`. Calls are stateless (`store: false`): the whole conversation is sent each step, and
// for reasoning models the encrypted reasoning items come back with it (`include: reasoning.encrypted_content`; the
// docs now say encrypted content is returned by default and the include is still accepted), which is what keeps a
// tool-calling turn coherent without OpenAI storing anything. Reasoning items (and messages that carry a `phase`) are
// replayed whole and in order; the system prompt is `instructions`, the same every turn. Streaming events used:
// response.output_text.delta for the words, response.completed (or .incomplete / .failed / error) for the end, whose
// `response.output` is the authoritative list of items (message, function_call, reasoning).
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
  ToolSpec,
} from "../types.ts";
import { type Endpoint, endpoint, send, streamFailure } from "./http.ts";

const OPENAI_BASE = "https://api.openai.com";

type Json = Record<string, unknown>;

export function openaiHeaders(apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
}

/** Models that think before they answer: their reasoning items must travel with the tool calls. */
const REASONING_MODEL = /^(o\d|gpt-5)/;
export const isReasoningModel = (id: string): boolean =>
  REASONING_MODEL.test(id);

function userItems(m: Message): Json[] {
  const items: Json[] = [];
  const images: Json[] = [];
  for (const b of m.blocks) {
    if (b.type === "tool_result") {
      items.push({
        call_id: b.callId,
        output: b.isError ? `ERROR: ${b.text}` : b.text,
        type: "function_call_output",
      });
      for (const img of b.images) {
        images.push(
          {
            text: `${img.label} (from the tool result above):`,
            type: "input_text",
          },
          {
            detail: "auto",
            image_url: `data:${img.mime};base64,${img.data}`,
            type: "input_image",
          }
        );
      }
    }
  }
  const content: Json[] = [];
  for (const b of m.blocks) {
    if (b.type === "text") {
      content.push({ text: b.text, type: "input_text" });
    } else if (b.type === "image") {
      content.push(
        { text: b.label, type: "input_text" },
        {
          detail: "auto",
          image_url: `data:${b.mime};base64,${b.data}`,
          type: "input_image",
        }
      );
    }
  }
  // images from tool results ride in a user message after the outputs, which every model accepts
  const all = [...images, ...content];
  if (all.length > 0) {
    items.push({ content: all, role: "user" });
  }
  return items;
}

function assistantItems(m: Message): Json[] {
  const items: Json[] = [];
  for (const b of m.blocks) {
    if (b.type === "text" && b.text) {
      items.push({ content: b.text, role: "assistant" });
    } else if (b.type === "tool_call") {
      items.push({
        arguments: JSON.stringify(b.input ?? {}),
        call_id: b.id,
        name: b.name,
        type: "function_call",
      });
    } else if (b.type === "opaque" && b.provider === "openai") {
      items.push(b.data as Json);
    }
  }
  return items;
}

/** The neutral messages as Responses API input items. Exported for the request-shape tests. */
function toInput(messages: readonly Message[]): Json[] {
  return messages.flatMap((m) =>
    m.role === "user" ? userItems(m) : assistantItems(m)
  );
}

function toWireTools(tools: readonly ToolSpec[]): Json[] {
  return tools.map((t) => ({
    description: t.description,
    name: t.name,
    parameters: t.inputSchema,
    strict: false,
    type: "function",
  }));
}

/** The request body. Exported for the request-shape tests. */
export function buildOpenAIBody(req: ProviderRequest): Json {
  return {
    ...(isReasoningModel(req.model)
      ? { include: ["reasoning.encrypted_content"] }
      : {}),
    input: toInput(req.messages),
    instructions: req.system.join("\n\n"),
    ...(req.maxTokens ? { max_output_tokens: req.maxTokens } : {}),
    model: req.model,
    store: false,
    stream: true,
    tools: toWireTools(req.tools),
  };
}

const ERROR_KIND: Record<string, AgentErrorKind> = {
  insufficient_quota: "rate_limit",
  invalid_api_key: "auth",
  rate_limit_exceeded: "rate_limit",
  server_error: "server",
};

function failure(code: unknown, message: unknown): AgentError {
  return new AgentError(ERROR_KIND[String(code)] ?? "unknown", {
    detail: String(message ?? "the stream reported an error"),
    provider: "openai",
  });
}

function parseArgs(item: Json): unknown {
  const raw = String(item.arguments ?? "");
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new AgentError("stream", {
      cause,
      detail: `The arguments of the ${String(item.name)} call were cut off.`,
      provider: "openai",
    });
  }
}

/** The finished response's output items as neutral blocks, in order. */
function blocksOf(output: Json[]): Block[] {
  const blocks: Block[] = [];
  for (const item of output) {
    if (item.type === "message" && typeof item.phase === "string") {
      // newer models label a message with a `phase`; the docs say to replay every output item as it came, so keep it whole
      blocks.push({ data: item, provider: "openai", type: "opaque" });
    } else if (item.type === "message") {
      const parts = (item.content as Json[] | undefined) ?? [];
      const text = parts
        .map((p) =>
          p.type === "output_text"
            ? String(p.text ?? "")
            : String(p.refusal ?? "")
        )
        .join("");
      if (text) {
        blocks.push({ text, type: "text" });
      }
    } else if (item.type === "function_call") {
      blocks.push({
        id: String(item.call_id),
        input: parseArgs(item),
        name: String(item.name),
        type: "tool_call",
      });
    } else {
      blocks.push({ data: item, provider: "openai", type: "opaque" });
    }
  }
  return blocks;
}

function reply(response: Json, incomplete: boolean): ProviderReply {
  const blocks = blocksOf((response.output as Json[] | undefined) ?? []);
  const u = response.usage as Json | undefined;
  const hasCall = blocks.some((b) => b.type === "tool_call");
  let stop: ProviderReply["stop"] = hasCall ? "tool_use" : "end";
  if (incomplete) {
    stop = "max_tokens";
  }
  return {
    blocks,
    stop,
    usage: u
      ? {
          input: Number(u.input_tokens ?? 0),
          output: Number(u.output_tokens ?? 0),
        }
      : null,
  };
}

async function complete(
  ep: Endpoint,
  apiKey: string,
  req: ProviderRequest,
  onText: (delta: string) => void
): Promise<ProviderReply> {
  const res = await send(ep, "/v1/responses", {
    body: JSON.stringify(buildOpenAIBody(req)),
    headers: openaiHeaders(apiKey),
    method: "POST",
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.body) {
    throw new AgentError("stream", { provider: "openai" });
  }
  try {
    for await (const ev of readSse(res.body)) {
      if (ev.data === "" || ev.data === "[DONE]") {
        continue;
      }
      const data = JSON.parse(ev.data) as Json;
      const type = String(data.type ?? ev.event ?? "");
      if (type === "response.output_text.delta") {
        onText(String(data.delta ?? ""));
      } else if (type === "response.completed") {
        return reply(data.response as Json, false);
      } else if (type === "response.incomplete") {
        return reply(data.response as Json, true);
      } else if (type === "response.failed") {
        const err = ((data.response as Json | undefined)?.error ?? {}) as Json;
        throw failure(err.code, err.message);
      } else if (type === "error") {
        throw failure(data.code, data.message);
      }
    }
  } catch (error) {
    throw streamFailure(error, ep, req.signal);
  }
  throw new AgentError("stream", { provider: "openai" });
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT =
  /(audio|realtime|transcribe|tts|image|search|embedding|moderation|whisper|dall|instruct|computer-use|deep-research|davinci|babbage|codex|sora|omni-moderation)/;

async function listModels(
  ep: Endpoint,
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelInfo[]> {
  const res = await send(ep, "/v1/models", {
    headers: openaiHeaders(apiKey),
    method: "GET",
    ...(signal ? { signal } : {}),
  });
  const body = (await res.json()) as {
    data?: { created?: number; id: string }[];
  };
  return (body.data ?? [])
    .filter((m) => CHAT_MODEL.test(m.id) && !NOT_CHAT.test(m.id))
    .map((m) => ({
      created: typeof m.created === "number" ? m.created : null,
      id: m.id,
      images: null,
      maxOutput: null,
      name: m.id,
    }))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

export function createOpenAI(opts: ProviderOptions): Provider {
  const ep = endpoint("openai", OPENAI_BASE, opts);
  return {
    complete: (req, onText) => complete(ep, opts.apiKey, req, onText),
    id: "openai",
    listModels: (signal) => listModels(ep, opts.apiKey, signal),
  };
}
