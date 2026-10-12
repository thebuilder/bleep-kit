// The vocabulary the agent loop, the provider adapters and the studio share. Messages are provider neutral: an adapter
// turns them into its own wire format and back, and keeps what only it understands (thinking blocks, reasoning items)
// in an `opaque` block that goes back to the same provider untouched.

export const PROVIDER_IDS = ["anthropic", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface TextBlock {
  text: string;
  type: "text";
}

/** A PNG the model looked at (or is shown): base64 without the data: prefix. */
export interface ImageBlock {
  /** Base64 of the PNG bytes. */
  data: string;
  height?: number;
  /** What it shows, for the thumbnail caption and for the model ("waveform of sfx/coin"). */
  label: string;
  mime: "image/png";
  type: "image";
  width?: number;
}

export interface ToolCallBlock {
  id: string;
  input: unknown;
  name: string;
  type: "tool_call";
}

export interface ToolResultBlock {
  callId: string;
  images: ImageBlock[];
  isError: boolean;
  text: string;
  type: "tool_result";
}

/** Something only the provider that produced it understands; sent back as is, in order. */
export interface OpaqueBlock {
  data: unknown;
  provider: ProviderId;
  type: "opaque";
}

export type Block =
  | TextBlock
  | ImageBlock
  | ToolCallBlock
  | ToolResultBlock
  | OpaqueBlock;

export interface Message {
  blocks: Block[];
  role: "user" | "assistant";
}

/** A tool as a provider sees it. */
export interface ToolSpec {
  description: string;
  inputSchema: JsonSchema;
  name: string;
}

/** The subset of JSON Schema the tools use (and the validator understands). */
export interface JsonSchema {
  additionalProperties?: boolean | JsonSchema;
  description?: string;
  enum?: readonly (string | number)[];
  items?: JsonSchema;
  maxItems?: number;
  maximum?: number;
  maxLength?: number;
  minItems?: number;
  minimum?: number;
  minLength?: number;
  pattern?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
}

export interface ModelInfo {
  /** Release time in seconds since the epoch, when the provider says. */
  created: number | null;
  id: string;
  /** False when the provider says the model takes no images, null when it does not say. */
  images: boolean | null;
  /** Largest reply the model can write, when the provider says. */
  maxOutput: number | null;
  /** The provider's display name, or the id. */
  name: string;
}

export interface ProviderRequest {
  /** Largest reply to ask for; the adapter picks a default. */
  maxTokens?: number;
  messages: Message[];
  model: string;
  signal?: AbortSignal;
  /** The system prompt in parts: the first is stable (cacheable), later ones change per turn. */
  system: string[];
  tools: ToolSpec[];
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "other";

export interface ProviderReply {
  /** The assistant's blocks in order: text, tool calls, opaque. */
  blocks: Block[];
  stop: StopReason;
  usage: { input: number; output: number } | null;
}

export interface Provider {
  /** One model turn, streamed: `onText` gets each piece of reply text as it arrives. */
  complete: (
    req: ProviderRequest,
    onText: (delta: string) => void
  ) => Promise<ProviderReply>;
  readonly id: ProviderId;
  /** The models this key can use, newest first. Doubles as a check that the key works. */
  listModels: (signal?: AbortSignal) => Promise<ModelInfo[]>;
}

export interface ProviderOptions {
  apiKey: string;
  /** Replaces `https://api.anthropic.com` or `https://api.openai.com` (tests, proxies the user runs themselves). */
  baseUrl?: string;
  /** Replaces the global fetch (tests). */
  fetch?: typeof fetch;
}
