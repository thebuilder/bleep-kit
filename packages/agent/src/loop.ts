// The agent loop: send the conversation, run the tool calls the model asks for, send their results, and repeat until
// the model answers in words. Bounded by a step limit, stoppable at any moment, and it always leaves the history in a
// state a provider will accept again (every tool call answered), whatever stopped it.
import { AgentError } from "./errors.ts";
import type { AgentTool, ToolOutput } from "./tool-kit.ts";
import type {
  Block,
  ImageBlock,
  Message,
  Provider,
  ProviderReply,
  ToolCallBlock,
  ToolResultBlock,
} from "./types.ts";

export const DEFAULT_MAX_STEPS = 24;
/** Pictures older than the newest few are dropped from what is sent: each one costs tokens at every later step. */
export const DEFAULT_KEEP_IMAGES = 4;

export type AgentEvent =
  | { type: "step"; step: number }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | {
      type: "tool_end";
      id: string;
      name: string;
      summary: string;
      isError: boolean;
      images: ImageBlock[];
    };

export interface RunOptions {
  /**
   * What the studio looked like when the person sent the message (the open document and so on). It becomes the first
   * block of the new user message and stays in the history, so the conversation only ever grows at its end. Putting it
   * in the system prompt instead would change the prompt between turns and make Anthropic refuse the thinking blocks
   * the conversation replays (their signatures are bound to everything before them).
   */
  context?: string;
  /** Earlier messages of the conversation; not modified. */
  history: readonly Message[];
  keepImages?: number;
  maxSteps?: number;
  maxTokens?: number;
  model: string;
  onEvent?: (event: AgentEvent) => void;
  /** The new user message. */
  prompt: string;
  provider: Provider;
  signal?: AbortSignal;
  system: string[];
  tools: readonly AgentTool[];
}

export type Outcome =
  | "done"
  | "step_limit"
  | "aborted"
  | "error"
  | "max_tokens";

export interface RunResult {
  error?: AgentError;
  /** The history plus this turn's messages, ready to be passed as `history` next time. */
  messages: Message[];
  outcome: Outcome;
  steps: number;
}

/** Counts pictures from the newest back; the ones past `keep` are dropped. */
class ImageBudget {
  private seen = 0;
  private readonly keep: number;

  constructor(keep: number) {
    this.keep = keep;
  }

  take(): boolean {
    this.seen += 1;
    return this.seen <= this.keep;
  }
}

function pruneResult(b: ToolResultBlock, budget: ImageBudget): ToolResultBlock {
  const kept: ImageBlock[] = [];
  const dropped: string[] = [];
  for (const img of [...b.images].reverse()) {
    if (budget.take()) {
      kept.unshift(img);
    } else {
      dropped.push(img.label);
    }
  }
  return dropped.length === 0
    ? b
    : {
        ...b,
        images: kept,
        text: `${b.text}\n[earlier pictures left out to save space: ${dropped.join(", ")}]`,
      };
}

function pruneBlock(b: Block, budget: ImageBudget): Block {
  if (b.type === "tool_result" && b.images.length > 0) {
    return pruneResult(b, budget);
  }
  if (b.type === "image" && !budget.take()) {
    return { text: `[picture left out: ${b.label}]`, type: "text" };
  }
  return b;
}

/** Anthropic's thinking blocks: signed, and bound to the system prompt, the tools and every message before them. */
function isThinking(b: Block): boolean {
  if (b.type !== "opaque" || b.provider !== "anthropic") {
    return false;
  }
  const type = (b.data as { type?: unknown } | null)?.type;
  return type === "thinking" || type === "redacted_thinking";
}

/** A copy without the thinking blocks of the messages from index `from` on (a block whose past changed is invalid). */
function dropThinking(messages: readonly Message[], from = 0): Message[] {
  return messages.map((m, i) =>
    i >= from && m.blocks.some(isThinking)
      ? { blocks: m.blocks.filter((b) => !isThinking(b)), role: m.role }
      : m
  );
}

/**
 * Everything older than the newest `keep` images, replaced by a note, in a copy. Rewriting a message changes the past
 * of every thinking block after it, so those blocks are left out of the copy (the model re-thinks, the API accepts).
 * With no more than `keep` pictures nothing is rewritten and the messages go out exactly as they are.
 */
export function pruneImages(
  messages: readonly Message[],
  keep: number
): Message[] {
  const pruned = prune(messages, keep);
  const first = pruned.findIndex((m, i) =>
    m.blocks.some((b, j) => b !== messages[i]?.blocks[j])
  );
  return first < 0 ? pruned : dropThinking(pruned, first);
}

function prune(messages: readonly Message[], keep: number): Message[] {
  const budget = new ImageBudget(keep);
  return [...messages]
    .reverse()
    .map((m) => ({
      blocks: [...m.blocks]
        .reverse()
        .map((b) => pruneBlock(b, budget))
        .reverse(),
      role: m.role,
    }))
    .reverse();
}

const cancelled = (call: ToolCallBlock): ToolResultBlock => ({
  callId: call.id,
  images: [],
  isError: true,
  text: "Not run: the person stopped the assistant.",
  type: "tool_result",
});

async function runCall(
  call: ToolCallBlock,
  tools: readonly AgentTool[],
  emit: (e: AgentEvent) => void
): Promise<ToolResultBlock> {
  emit({ id: call.id, input: call.input, name: call.name, type: "tool_start" });
  const tool = tools.find((t) => t.spec.name === call.name);
  let out: ToolOutput;
  if (tool) {
    try {
      out = await tool.run(call.input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      out = {
        isError: true,
        summary: `${call.name}: failed`,
        text: `${call.name} failed: ${message}`,
      };
    }
  } else {
    out = {
      isError: true,
      summary: `Unknown tool ${call.name}`,
      text: `There is no tool named ${call.name}. The tools are: ${tools.map((t) => t.spec.name).join(", ")}.`,
    };
  }
  const images = out.images ?? [];
  emit({
    id: call.id,
    images,
    isError: out.isError ?? false,
    name: call.name,
    summary: out.summary,
    type: "tool_end",
  });
  return {
    callId: call.id,
    images,
    isError: out.isError ?? false,
    text: out.text,
    type: "tool_result",
  };
}

function toAgentError(
  error: unknown,
  signal: AbortSignal | undefined
): AgentError {
  if (error instanceof AgentError) {
    return error;
  }
  if (
    signal?.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new AgentError("aborted");
  }
  return new AgentError("unknown", {
    detail: error instanceof Error ? error.message : String(error),
  });
}

/** One model turn: stream the reply. The error, if any, comes back as a value so the loop can decide. */
async function askModel(
  opts: RunOptions,
  messages: readonly Message[],
  emit: (e: AgentEvent) => void
): Promise<{ reply: ProviderReply } | { error: AgentError }> {
  try {
    const reply = await opts.provider.complete(
      {
        messages: pruneImages(messages, opts.keepImages ?? DEFAULT_KEEP_IMAGES),
        model: opts.model,
        system: opts.system,
        tools: opts.tools.map((t) => t.spec),
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (delta) => emit({ delta, type: "text" })
    );
    return { reply };
  } catch (error) {
    return { error: toAgentError(error, opts.signal) };
  }
}

/** Run the calls one after another, in the order the model made them. Calls after a stop are answered, not run. */
async function runCalls(
  calls: readonly ToolCallBlock[],
  opts: RunOptions,
  emit: (e: AgentEvent) => void
): Promise<ToolResultBlock[]> {
  const results: ToolResultBlock[] = [];
  for (const call of calls) {
    if (opts.signal?.aborted) {
      results.push(cancelled(call));
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: sequential on purpose, a later call may depend on an earlier one's edit
    results.push(await runCall(call, opts.tools, emit));
  }
  return results;
}

const endOutcome = (reply: ProviderReply): Outcome =>
  reply.stop === "max_tokens" ? "max_tokens" : "done";

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const emit = opts.onEvent ?? (() => undefined);
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const messages: Message[] = [
    ...opts.history,
    {
      blocks: [
        ...(opts.context
          ? [{ text: opts.context, type: "text" as const }]
          : []),
        { text: opts.prompt, type: "text" },
      ],
      role: "user",
    },
  ];
  const finish = (
    outcome: Outcome,
    steps: number,
    error?: AgentError
  ): RunResult => ({
    messages,
    outcome,
    steps,
    ...(error ? { error } : {}),
  });

  for (let step = 1; step <= maxSteps; step += 1) {
    if (opts.signal?.aborted) {
      return finish("aborted", step - 1);
    }
    emit({ step, type: "step" });
    // biome-ignore lint/performance/noAwaitInLoops: each step needs the previous step's tool results
    let answer = await askModel(opts, messages, emit);
    if ("error" in answer && answer.error.staleThinking) {
      // the provider no longer accepts the thinking blocks it gave us: forget them for good and ask again
      messages.splice(0, messages.length, ...dropThinking(messages));
      answer = await askModel(opts, messages, emit);
    }
    if ("error" in answer) {
      return finish(
        answer.error.kind === "aborted" ? "aborted" : "error",
        step,
        answer.error
      );
    }
    const { reply } = answer;
    if (reply.blocks.length > 0) {
      messages.push({ blocks: reply.blocks, role: "assistant" });
    }
    const calls = reply.blocks.filter(
      (b): b is ToolCallBlock => b.type === "tool_call"
    );
    if (calls.length === 0) {
      return finish(endOutcome(reply), step);
    }
    messages.push({ blocks: await runCalls(calls, opts, emit), role: "user" });
    if (opts.signal?.aborted) {
      return finish("aborted", step);
    }
  }
  return finish("step_limit", maxSteps);
}
