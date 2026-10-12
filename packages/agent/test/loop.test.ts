import { describe, expect, it } from "vitest";
import {
  AgentError,
  type AgentEvent,
  type AgentTool,
  type Block,
  createTools,
  type Message,
  type Provider,
  type ProviderReply,
  type ProviderRequest,
  pruneImages,
  runAgent,
} from "../src/index.ts";
import { seededHost } from "./fake-host.ts";

type Step =
  | ProviderReply
  | Error
  | ((req: ProviderRequest) => ProviderReply | Promise<ProviderReply>);

/** A provider that plays back a script, recording what it was asked. */
function scripted(steps: Step[]): Provider & { requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  return {
    complete: async (req, onText) => {
      const { signal: _signal, ...plain } = req;
      requests.push(structuredClone(plain));
      const step = steps.shift();
      if (!step) {
        throw new Error("script ran out");
      }
      if (step instanceof Error) {
        throw step;
      }
      const reply = typeof step === "function" ? await step(req) : step;
      for (const b of reply.blocks) {
        if (b.type === "text") {
          onText(b.text);
        }
      }
      return reply;
    },
    id: "anthropic",
    listModels: () => Promise.resolve([]),
    requests,
  };
}

const say = (text: string): ProviderReply => ({
  blocks: [{ text, type: "text" }],
  stop: "end",
  usage: null,
});
const call = (
  id: string,
  name: string,
  input: unknown,
  text?: string
): ProviderReply => ({
  blocks: [
    ...(text ? [{ text, type: "text" as const }] : []),
    { id, input, name, type: "tool_call" },
  ],
  stop: "tool_use",
  usage: null,
});

const base = (
  provider: Provider,
  tools: readonly AgentTool[],
  over: Partial<Parameters<typeof runAgent>[0]> = {}
) => ({
  history: [] as Message[],
  model: "m",
  prompt: "make a coin",
  provider,
  system: ["sys"],
  tools,
  ...over,
});

describe("runAgent", () => {
  it("round-trips a tool call: run it, send the result, then the answer", async () => {
    const host = seededHost();
    const events: AgentEvent[] = [];
    const provider = scripted([
      call("c1", "new_sfx", { category: "coin", id: "ding" }, "Making it."),
      call("c2", "render_analyze", { ref: "sfx/ding" }),
      say("Done: peak -9 dBFS."),
    ]);
    const res = await runAgent(
      base(provider, createTools(host), { onEvent: (e) => events.push(e) })
    );
    expect(res.outcome).toBe("done");
    expect(res.steps).toBe(3);
    expect(host.docs.has("sfx/ding")).toBe(true);
    expect(
      events
        .filter((e) => e.type === "tool_end")
        .map((e) => (e.type === "tool_end" ? e.summary : ""))
    ).toEqual([
      "Created sfx/ding (nes coin)",
      "Rendered sfx/ding: peak -9.1 dBFS, 0.32 s, no clipping",
    ]);
    expect(
      events
        .filter((e) => e.type === "text")
        .map((e) => (e.type === "text" ? e.delta : ""))
        .join("")
    ).toBe("Making it.Done: peak -9 dBFS.");
    // the second request carries the first tool result, after the assistant's tool call
    const second = provider.requests[1]?.messages ?? [];
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const result = second[2]?.blocks[0];
    expect(result?.type).toBe("tool_result");
    expect(result && "callId" in result ? result.callId : "").toBe("c1");
    // the returned history can seed the next turn
    expect(res.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("feeds a refused edit back so the model can fix it", async () => {
    const host = seededHost();
    const provider = scripted([
      call("c1", "write_document", {
        json: { version: 1, wave: "banana" },
        ref: "sfx/bad",
      }),
      say("Fixed."),
    ]);
    const res = await runAgent(base(provider, createTools(host)));
    expect(res.outcome).toBe("done");
    expect(host.docs.has("sfx/bad")).toBe(false);
    const block = provider.requests[1]?.messages.at(-1)?.blocks[0];
    expect(block && block.type === "tool_result" && block.isError).toBe(true);
    expect(block && block.type === "tool_result" && block.text).toContain(
      "nothing was saved"
    );
  });

  it("answers an unknown tool with the list of real ones", async () => {
    const provider = scripted([call("c1", "make_coffee", {}), say("ok")]);
    const res = await runAgent(base(provider, createTools(seededHost())));
    expect(res.outcome).toBe("done");
    const block = provider.requests[1]?.messages.at(-1)?.blocks[0];
    expect(block && block.type === "tool_result" && block.text).toContain(
      "There is no tool named make_coffee"
    );
  });

  it("stops at the step limit and leaves a history that can be sent again", async () => {
    const host = seededHost();
    const provider = scripted(
      Array.from({ length: 5 }, (_, i) => call(`c${i}`, "list_documents", {}))
    );
    const res = await runAgent(
      base(provider, createTools(host), { maxSteps: 3 })
    );
    expect(res.outcome).toBe("step_limit");
    expect(res.steps).toBe(3);
    expect(provider.requests).toHaveLength(3);
    // every tool call has its result
    const calls = res.messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === "tool_call");
    const results = res.messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(calls.length);
  });

  it("aborts between steps, answering the calls it did not run", async () => {
    const host = seededHost();
    const ac = new AbortController();
    const provider = scripted([
      {
        blocks: [
          { id: "a", input: {}, name: "list_documents", type: "tool_call" },
          {
            id: "b",
            input: { ref: "sfx/coin" },
            name: "play",
            type: "tool_call",
          },
        ],
        stop: "tool_use",
        usage: null,
      },
    ]);
    const tools = createTools(host);
    const first = tools.find(
      (t) => t.spec.name === "list_documents"
    ) as AgentTool;
    const wrapped: AgentTool[] = tools.map((t) =>
      t === first
        ? {
            ...t,
            run: async (i: unknown) => {
              const r = await t.run(i);
              ac.abort();
              return r;
            },
          }
        : t
    );
    const res = await runAgent(base(provider, wrapped, { signal: ac.signal }));
    expect(res.outcome).toBe("aborted");
    expect(host.calls).not.toContain("play sfx/coin");
    const results = res.messages
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === "tool_result");
    expect(results).toHaveLength(2);
    expect(
      results[1] && results[1].type === "tool_result" && results[1].text
    ).toContain("stopped");
  });

  it("aborts before the first request", async () => {
    const ac = new AbortController();
    ac.abort();
    const provider = scripted([say("never")]);
    const res = await runAgent(base(provider, [], { signal: ac.signal }));
    expect(res.outcome).toBe("aborted");
    expect(provider.requests).toHaveLength(0);
  });

  it("reports a provider error with its kind and keeps the user message", async () => {
    const provider = scripted([
      new AgentError("auth", { provider: "anthropic", status: 401 }),
    ]);
    const res = await runAgent(base(provider, []));
    expect(res.outcome).toBe("error");
    expect(res.error?.kind).toBe("auth");
    expect(res.messages).toHaveLength(1);
  });

  it("turns an abort error from the provider into an aborted outcome", async () => {
    const provider = scripted([new AgentError("aborted")]);
    const res = await runAgent(base(provider, []));
    expect(res.outcome).toBe("aborted");
  });

  it("survives a tool that throws", async () => {
    const boom: AgentTool = {
      run: () => Promise.reject(new Error("disk on fire")),
      spec: { description: "x", inputSchema: { type: "object" }, name: "boom" },
    };
    const provider = scripted([call("c1", "boom", {}), say("sorry")]);
    const res = await runAgent(base(provider, [boom]));
    expect(res.outcome).toBe("done");
    const block = provider.requests[1]?.messages.at(-1)?.blocks[0];
    expect(block && block.type === "tool_result" && block.text).toContain(
      "disk on fire"
    );
  });

  it("passes the history, the system parts and the tool specs to the provider", async () => {
    const host = seededHost();
    const earlier: Message[] = [
      { blocks: [{ text: "hi", type: "text" }], role: "user" },
      { blocks: [{ text: "hello", type: "text" }], role: "assistant" },
    ];
    const provider = scripted([say("ok")]);
    await runAgent(
      base(provider, createTools(host), {
        history: earlier,
        system: ["a", "b"],
      })
    );
    const [req] = provider.requests;
    expect(req?.messages).toHaveLength(3);
    expect(req?.system).toEqual(["a", "b"]);
    expect(req?.tools.length).toBeGreaterThan(8);
    expect(earlier).toHaveLength(2);
  });
});

describe("pruneImages", () => {
  const img = (label: string): Block => ({
    data: "AA==",
    label,
    mime: "image/png",
    type: "image",
  });
  const result = (id: string, labels: string[]): Message => ({
    blocks: [
      {
        callId: id,
        images: labels.map((l) => img(l) as never),
        isError: false,
        text: "pics",
        type: "tool_result",
      },
    ],
    role: "user",
  });

  it("keeps the newest pictures and replaces older ones with a note, without touching the input", () => {
    const messages = [
      result("1", ["a", "b"]),
      result("2", ["c"]),
      result("3", ["d", "e"]),
    ];
    const out = pruneImages(messages, 3);
    const labels = out
      .flatMap((m) => m.blocks)
      .flatMap((b) =>
        b.type === "tool_result" ? b.images.map((i) => i.label) : []
      );
    expect(labels).toEqual(["c", "d", "e"]);
    const first = out[0]?.blocks[0];
    expect(first && first.type === "tool_result" && first.text).toContain(
      "left out"
    );
    expect(
      messages[0]?.blocks[0] &&
        "images" in messages[0].blocks[0] &&
        messages[0].blocks[0].images
    ).toHaveLength(2);
  });
});

describe("thinking blocks and the conversation's past", () => {
  const thought = (sig: string): Block => ({
    data: { signature: sig, thinking: "", type: "thinking" },
    provider: "anthropic",
    type: "opaque",
  });
  const picture = (label: string): Block => ({
    data: "AA==",
    label,
    mime: "image/png",
    type: "image",
  });
  const history = (): Message[] => [
    { blocks: [{ text: "one", type: "text" }, picture("old")], role: "user" },
    {
      blocks: [thought("s1"), { text: "hi", type: "text" }],
      role: "assistant",
    },
    { blocks: [{ text: "two", type: "text" }, picture("new")], role: "user" },
    {
      blocks: [thought("s2"), { text: "ok", type: "text" }],
      role: "assistant",
    },
  ];

  it("sends the history untouched when no picture has to go, thinking blocks included", () => {
    const messages = history();
    expect(pruneImages(messages, 4)).toEqual(messages);
  });

  it("leaves out the thinking blocks after a message it had to rewrite, and keeps the ones before it", () => {
    const out = pruneImages(history(), 1);
    // the old picture is a note now, so every thinking block after that message is no longer valid
    expect(JSON.stringify(out)).not.toContain("s1");
    expect(JSON.stringify(out)).not.toContain("s2");
    expect(out[1]?.blocks).toEqual([{ text: "hi", type: "text" }]);
    const early = history();
    early.unshift({
      blocks: [thought("s0"), { text: "hello", type: "text" }],
      role: "assistant",
    });
    expect(JSON.stringify(pruneImages(early, 1))).toContain("s0");
  });

  it("puts the studio state in the new user message and sends the past back unchanged on the next turn", async () => {
    const provider = scripted([
      {
        ...say("one"),
        blocks: [thought("sig-1"), { text: "one", type: "text" }],
      },
      say("two"),
    ]);
    const first = await runAgent(
      base(provider, [], { context: "[state A]", system: ["fixed"] })
    );
    await runAgent(
      base(provider, [], {
        context: "[state B]",
        history: first.messages,
        prompt: "again",
        system: ["fixed"],
      })
    );
    const [a, b] = provider.requests;
    expect(a?.messages[0]?.blocks).toEqual([
      { text: "[state A]", type: "text" },
      { text: "make a coin", type: "text" },
    ]);
    expect(b?.system).toEqual(a?.system);
    expect(JSON.stringify(b?.messages.slice(0, 2))).toBe(
      JSON.stringify([a?.messages[0], first.messages[1]])
    );
    expect(b?.messages[2]?.blocks[0]).toEqual({
      text: "[state B]",
      type: "text",
    });
  });

  it("drops the thinking from the history for good and asks again when the provider refuses it", async () => {
    const refusal = new AgentError("bad_request", {
      detail: "Invalid `signature` in `thinking` block",
      provider: "anthropic",
      staleThinking: true,
      status: 400,
    });
    const provider = scripted([refusal, say("fine")]);
    const res = await runAgent(base(provider, [], { history: history() }));
    expect(res.outcome).toBe("done");
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[0]?.messages)).toContain("s1");
    expect(JSON.stringify(provider.requests[1]?.messages)).not.toContain(
      "thinking"
    );
    expect(JSON.stringify(res.messages)).not.toContain("thinking");
  });

  it("does not retry other refusals, nor more than once", async () => {
    const plain = new AgentError("bad_request", { status: 400 });
    const stale = new AgentError("bad_request", {
      staleThinking: true,
      status: 400,
    });
    const one = scripted([plain]);
    expect((await runAgent(base(one, []))).outcome).toBe("error");
    expect(one.requests).toHaveLength(1);
    const two = scripted([stale, stale]);
    const res = await runAgent(base(two, []));
    expect(res.outcome).toBe("error");
    expect(two.requests).toHaveLength(2);
  });
});
