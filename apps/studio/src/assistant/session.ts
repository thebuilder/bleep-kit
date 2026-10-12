/* One conversation with the assistant: the messages the provider sees, the entries the panel shows, and the run that
   turns a typed request into streamed replies and tool calls. It owns no DOM. The key is read from the settings at the
   moment of each request and handed only to the provider adapter. */
import {
  type AgentEvent,
  buildSystem,
  createProvider,
  createTools,
  explain,
  type ImageBlock,
  type Message,
  type ModelInfo,
  type Provider,
  type ProviderId,
  pickDefaultModel,
  runAgent,
  turnContext,
} from "@bleepkit/agent";
import { createEmitter } from "../lib/emitter.ts";
import type { StudioHost } from "./host.ts";
import type { AssistantSettings } from "./settings.ts";

export interface ToolEntry {
  id: number;
  images: ImageBlock[];
  isError: boolean;
  name: string;
  running: boolean;
  summary: string;
  target: string;
  type: "tool";
}

export type Entry =
  | { id: number; text: string; type: "user" }
  | { id: number; streaming: boolean; text: string; type: "assistant" }
  | ToolEntry
  | { id: number; text: string; tone: "error" | "info"; type: "notice" };

/** What the person needs to do before the assistant can answer, or null when it is ready. */
export type Setup = "key" | "model" | null;

const OUTCOME_NOTES = {
  max_tokens:
    "The reply hit the length limit and was cut off. Ask me to continue.",
  step_limit:
    "I stopped after many steps in a row, in case something was going in circles. Say continue to go on.",
} as const;

function targetOf(input: unknown): string {
  if (typeof input === "object" && input !== null) {
    const { ref, id, kind } = input as Record<string, unknown>;
    if (typeof ref === "string") {
      return ref;
    }
    if (typeof kind === "string" && typeof id === "string") {
      return `${kind}/${id}`;
    }
    if (typeof id === "string") {
      return id;
    }
  }
  return "";
}

export class AssistantSession {
  entries: Entry[] = [];
  /** The models the last successful check of each provider's key listed. */
  readonly models: Partial<Record<ProviderId, ModelInfo[]>> = {};
  private messages: Message[] = [];
  private control: AbortController | null = null;

  /** True from sending a request until its turn is over. */
  get busy(): boolean {
    return this.control !== null;
  }
  private nextId = 1;
  private readonly changes = createEmitter();
  private readonly host: StudioHost;
  private readonly settings: AssistantSettings;
  private readonly makeProvider: (id: ProviderId, key: string) => Provider;

  constructor(
    host: StudioHost,
    settings: AssistantSettings,
    makeProvider: (id: ProviderId, key: string) => Provider = (id, key) =>
      createProvider(id, { apiKey: key })
  ) {
    this.host = host;
    this.settings = settings;
    this.makeProvider = makeProvider;
  }

  subscribe(fn: () => void): () => void {
    return this.changes.subscribe(fn);
  }

  private emit(): void {
    this.changes.emit();
  }

  private id(): number {
    this.nextId += 1;
    return this.nextId;
  }

  private notice(text: string, tone: "error" | "info"): void {
    this.entries.push({ id: this.id(), text, tone, type: "notice" });
  }

  /** The provider, key and model in use, and what is missing if anything is. */
  status(): { model: string; provider: ProviderId; setup: Setup } {
    const { provider, models } = this.settings.choices();
    const key = this.settings.keyOf(provider);
    const model = models[provider] ?? "";
    let setup: Setup = null;
    if (!key) {
      setup = "key";
    } else if (!model) {
      setup = "model";
    }
    return { model, provider, setup };
  }

  /** Models of one provider with this key (also a check that the key works). Remembers the list. */
  async loadModels(
    provider: ProviderId,
    key: string,
    signal?: AbortSignal
  ): Promise<ModelInfo[]> {
    const list = await this.makeProvider(provider, key).listModels(signal);
    this.models[provider] = list;
    return list;
  }

  /** Fill in a model for a key that was saved without one (a key remembered from another visit). */
  async ensureModel(): Promise<void> {
    const { provider, setup } = this.status();
    if (setup !== "model") {
      return;
    }
    const list = await this.loadModels(provider, this.settings.keyOf(provider));
    // the person may have picked a model while the list was loading: theirs wins over the default
    if (this.status().setup !== "model") {
      return;
    }
    const pick = pickDefaultModel(provider, list);
    if (pick) {
      this.settings.saveChoices({ models: { [provider]: pick.id } });
    }
  }

  stop(): void {
    this.control?.abort();
  }

  /** A new, empty conversation. Does nothing while a reply is running. */
  clear(): void {
    if (this.busy) {
      return;
    }
    this.messages = [];
    this.entries = [];
    this.emit();
  }

  private onEvent(e: AgentEvent): void {
    const last = this.entries.at(-1);
    if (e.type === "step" && last?.type === "assistant") {
      last.streaming = false;
    } else if (e.type === "text") {
      if (last?.type === "assistant" && last.streaming) {
        last.text += e.delta;
      } else {
        this.entries.push({
          id: this.id(),
          streaming: true,
          text: e.delta,
          type: "assistant",
        });
      }
    } else if (e.type === "tool_start") {
      if (last?.type === "assistant") {
        last.streaming = false;
      }
      const entry: ToolEntry = {
        id: this.id(),
        images: [],
        isError: false,
        name: e.name,
        running: true,
        summary: "",
        target: targetOf(e.input),
        type: "tool",
      };
      this.entries.push(entry);
      this.tools.set(e.id, entry);
    } else if (e.type === "tool_end") {
      const entry = this.tools.get(e.id);
      if (entry) {
        entry.running = false;
        entry.summary = e.summary;
        entry.isError = e.isError;
        entry.images = e.images;
      }
    }
    this.emit();
  }

  private readonly tools = new Map<string, ToolEntry>();

  /** Send a request. Resolves when the turn is over; failures become notices in the conversation. */
  async send(text: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt || this.busy) {
      return;
    }
    const { model, provider, setup } = this.status();
    if (setup) {
      this.notice("Add your API key in the assistant settings first.", "error");
      this.emit();
      return;
    }
    this.entries.push({ id: this.id(), text: prompt, type: "user" });
    this.control = new AbortController();
    const { signal } = this.control;
    this.emit();
    this.host.beginTurn(signal);
    try {
      const info = this.models[provider]?.find((m) => m.id === model);
      const result = await runAgent({
        // the open document goes in the new user message, never in the system prompt (which stays the same all
        // conversation), so the conversation only grows at its end and replayed thinking blocks stay valid
        context: turnContext({
          current: this.host.current(),
          project: await this.host.project(),
        }),
        history: this.messages,
        model,
        onEvent: (e) => this.onEvent(e),
        prompt,
        provider: this.makeProvider(provider, this.settings.keyOf(provider)),
        signal,
        system: buildSystem(),
        tools: createTools(this.host, { images: info?.images !== false }),
      });
      this.messages = result.messages;
      this.finish(result.outcome, result.error);
    } catch (error) {
      this.notice(explain(error), "error");
    } finally {
      this.host.endTurn();
      this.control = null;
      for (const e of this.entries) {
        if (e.type === "assistant") {
          e.streaming = false;
        }
        if (e.type === "tool" && e.running) {
          e.running = false;
        }
      }
      this.emit();
    }
  }

  private finish(
    outcome: "done" | "step_limit" | "aborted" | "error" | "max_tokens",
    error: unknown
  ): void {
    if (outcome === "error") {
      this.notice(explain(error), "error");
    } else if (outcome === "aborted") {
      this.notice("Stopped.", "info");
    } else if (outcome === "step_limit" || outcome === "max_tokens") {
      this.notice(OUTCOME_NOTES[outcome], "info");
    }
  }
}
