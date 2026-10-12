// @bleepkit/agent: what an AI assistant needs to make game audio with Bleepkit without hearing it. Tools over an
// abstract host, the system prompt, provider adapters that call Anthropic and OpenAI straight from the browser, and the
// loop that ties them together. Browser safe: no Node imports.
export { analysisText, checks } from "./analysis-text.ts";
export {
  defaultKindFor,
  kindsForChip,
  makeSong,
  PRESETS,
  type Preset,
  type Template,
} from "./author.ts";
export {
  describeInstrument,
  describeSong,
  fmtSeconds,
  songFacts,
} from "./describe.ts";
export {
  AgentError,
  type AgentErrorKind,
  explain,
  kindForStatus,
  providerName,
} from "./errors.ts";
export {
  type AgentHost,
  type AgentImage,
  type AnyDoc,
  DOC_KINDS,
  type DocKind,
  type DocRef,
  type DocSummary,
  type ImageKind,
  isDocId,
  type Measured,
  type ProjectSummary,
  parseRef,
  refText,
  type SampleInfo,
} from "./host.ts";
export {
  type AgentEvent,
  DEFAULT_KEEP_IMAGES,
  DEFAULT_MAX_STEPS,
  type Outcome,
  pruneImages,
  type RunOptions,
  type RunResult,
  runAgent,
} from "./loop.ts";
export { applyChanges, type Change, getAt } from "./pointer.ts";
export { baseSystemPrompt, buildSystem, turnContext } from "./prompt.ts";
export {
  ANTHROPIC_VERSION,
  anthropicHeaders,
  buildAnthropicBody,
} from "./providers/anthropic.ts";
export { createProvider, PROVIDER_LABELS } from "./providers/index.ts";
export { pickDefaultModel } from "./providers/models.ts";
export {
  buildOpenAIBody,
  isReasoningModel,
  openaiHeaders,
} from "./providers/openai.ts";
export {
  FORMAT_SECTIONS,
  FORMAT_TEXT,
  type FormatSection,
  WORKFLOW_TEXT,
} from "./reference.ts";
export { type Checked, checkInput } from "./schema.ts";
export { readSse, type SseEvent } from "./sse.ts";
export { type AgentTool, MAX_TOOL_TEXT, type ToolOutput } from "./tool-kit.ts";
export { createTools, type ToolOptions } from "./tools/index.ts";
export {
  type Block,
  type ImageBlock,
  type JsonSchema,
  type Message,
  type ModelInfo,
  PROVIDER_IDS,
  type Provider,
  type ProviderId,
  type ProviderOptions,
  type ProviderReply,
  type ProviderRequest,
  type StopReason,
  type TextBlock,
  type ToolCallBlock,
  type ToolResultBlock,
  type ToolSpec,
} from "./types.ts";
