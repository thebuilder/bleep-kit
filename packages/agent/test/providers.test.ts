import { describe, expect, it } from "vitest";
import {
  AgentError,
  anthropicHeaders,
  buildAnthropicBody,
  buildOpenAIBody,
  createProvider,
  explain,
  isReasoningModel,
  type Message,
  type ProviderRequest,
  type ToolSpec,
} from "../src/index.ts";

const tools: ToolSpec[] = [
  {
    description: "Look at the project.",
    inputSchema: {
      properties: { kind: { enum: ["sfx", "song"], type: "string" } },
      type: "object",
    },
    name: "list_documents",
  },
];

const messages: Message[] = [
  { blocks: [{ text: "make a coin", type: "text" }], role: "user" },
  {
    blocks: [
      {
        data: { signature: "sig", thinking: "hmm", type: "thinking" },
        provider: "anthropic",
        type: "opaque",
      },
      {
        data: { id: "rs_1", type: "reasoning" },
        provider: "openai",
        type: "opaque",
      },
      { text: "Looking.", type: "text" },
      {
        id: "toolu_1",
        input: { kind: "sfx" },
        name: "list_documents",
        type: "tool_call",
      },
    ],
    role: "assistant",
  },
  {
    blocks: [
      {
        callId: "toolu_1",
        images: [
          {
            data: "AAAA",
            label: "waveform of sfx/coin",
            mime: "image/png",
            type: "image",
          },
        ],
        isError: false,
        text: "sfx/coin",
        type: "tool_result",
      },
      { text: "and louder", type: "text" },
    ],
    role: "user",
  },
];

const request = (over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  messages,
  model: "model-x",
  system: ["stable part", "turn part"],
  tools,
  ...over,
});

/** A fetch that records calls and answers from a list of canned responses. */
function fakeFetch(...answers: (Response | Error)[]) {
  const calls: {
    body: unknown;
    headers: Record<string, string>;
    method: string;
    url: string;
  }[] = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: init?.headers as Record<string, string>,
      method: init?.method ?? "GET",
      url: String(input),
    });
    const a = answers.shift();
    if (!a) {
      return Promise.reject(new Error("no more answers"));
    }
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  }) as typeof fetch;
  return { calls, fetch: fn };
}

const sse = (events: [string, unknown][]) =>
  new Response(
    events
      .map(
        ([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
      )
      .join(""),
    {
      headers: { "content-type": "text/event-stream" },
    }
  );
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("Anthropic request shape", () => {
  it("carries the browser-access header, the version and the key, and nothing else secret", () => {
    const h = anthropicHeaders("sk-ant-test");
    expect(h).toEqual({
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": "sk-ant-test",
    });
  });

  it("builds the Messages API body with input_schema tools and a cached stable system part", () => {
    const body = buildAnthropicBody(request()) as Record<string, unknown>;
    expect(body.model).toBe("model-x");
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(8192);
    expect(body.tools).toEqual([
      {
        description: "Look at the project.",
        input_schema: tools[0]?.inputSchema,
        name: "list_documents",
      },
    ]);
    expect(body.system).toEqual([
      {
        cache_control: { type: "ephemeral" },
        text: "stable part",
        type: "text",
      },
      { text: "turn part", type: "text" },
    ]);
  });

  it("turns messages into tool_use / tool_result blocks, results first, images inside the result", () => {
    const wire = buildAnthropicBody(request({ maxTokens: 1000 })) as {
      max_tokens: number;
      messages: { content: Record<string, unknown>[]; role: string }[];
    };
    expect(wire.max_tokens).toBe(1000);
    const [user1, assistant, user2] = wire.messages;
    expect(user1).toEqual({
      content: [{ text: "make a coin", type: "text" }],
      role: "user",
    });
    // thinking block of this provider is kept, the other provider's reasoning item is dropped
    expect(assistant?.content.map((b) => b.type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
    expect(assistant?.content[2]).toEqual({
      id: "toolu_1",
      input: { kind: "sfx" },
      name: "list_documents",
      type: "tool_use",
    });
    expect(user2?.content.map((b) => b.type)).toEqual(["tool_result", "text"]);
    const result = user2?.content[0] as {
      content: Record<string, unknown>[];
      tool_use_id: string;
    };
    expect(result.tool_use_id).toBe("toolu_1");
    expect(result.content.map((b) => b.type)).toEqual([
      "text",
      "text",
      "image",
    ]);
    expect(result.content[2]).toEqual({
      source: { data: "AAAA", media_type: "image/png", type: "base64" },
      type: "image",
    });
  });

  it("marks failed tool results with is_error", () => {
    const wire = buildAnthropicBody({
      ...request(),
      messages: [
        {
          blocks: [
            {
              callId: "t",
              images: [],
              isError: true,
              text: "no",
              type: "tool_result",
            },
          ],
          role: "user",
        },
      ],
    }) as { messages: { content: Record<string, unknown>[] }[] };
    expect(wire.messages[0]?.content[0]).toMatchObject({
      content: "no",
      is_error: true,
      tool_use_id: "t",
      type: "tool_result",
    });
  });
});

describe("Anthropic calls", () => {
  it("POSTs to /v1/messages with the browser header and parses a streamed tool call", async () => {
    const f = fakeFetch(
      sse([
        [
          "message_start",
          {
            message: { usage: { input_tokens: 10, output_tokens: 1 } },
            type: "message_start",
          },
        ],
        [
          "content_block_start",
          {
            content_block: { text: "", type: "text" },
            index: 0,
            type: "content_block_start",
          },
        ],
        ["ping", { type: "ping" }],
        [
          "content_block_delta",
          {
            delta: { text: "Let's ", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { text: "look.", type: "text_delta" },
            index: 0,
            type: "content_block_delta",
          },
        ],
        ["content_block_stop", { index: 0, type: "content_block_stop" }],
        [
          "content_block_start",
          {
            content_block: {
              id: "toolu_9",
              input: {},
              name: "list_documents",
              type: "tool_use",
            },
            index: 1,
            type: "content_block_start",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { partial_json: "", type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { partial_json: '{"kind":', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { partial_json: ' "sfx"}', type: "input_json_delta" },
            index: 1,
            type: "content_block_delta",
          },
        ],
        ["content_block_stop", { index: 1, type: "content_block_stop" }],
        [
          "message_delta",
          {
            delta: { stop_reason: "tool_use", stop_sequence: null },
            type: "message_delta",
            usage: { output_tokens: 33 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ])
    );
    const provider = createProvider("anthropic", {
      apiKey: "sk-ant-test",
      fetch: f.fetch,
    });
    const text: string[] = [];
    const reply = await provider.complete(request(), (d) => text.push(d));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(f.calls[0]?.method).toBe("POST");
    expect(
      f.calls[0]?.headers["anthropic-dangerous-direct-browser-access"]
    ).toBe("true");
    expect(f.calls[0]?.headers["x-api-key"]).toBe("sk-ant-test");
    expect(text.join("")).toBe("Let's look.");
    expect(reply.stop).toBe("tool_use");
    expect(reply.usage).toEqual({ input: 10, output: 33 });
    expect(reply.blocks).toEqual([
      { text: "Let's look.", type: "text" },
      {
        id: "toolu_9",
        input: { kind: "sfx" },
        name: "list_documents",
        type: "tool_call",
      },
    ]);
  });

  it("keeps thinking blocks (with their signature) so they go back untouched", async () => {
    const f = fakeFetch(
      sse([
        [
          "message_start",
          { message: { usage: { input_tokens: 1 } }, type: "message_start" },
        ],
        [
          "content_block_start",
          {
            content_block: { thinking: "", type: "thinking" },
            index: 0,
            type: "content_block_start",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { thinking: "plan", type: "thinking_delta" },
            index: 0,
            type: "content_block_delta",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { signature: "SIG", type: "signature_delta" },
            index: 0,
            type: "content_block_delta",
          },
        ],
        ["content_block_stop", { index: 0, type: "content_block_stop" }],
        [
          "content_block_start",
          {
            content_block: { text: "", type: "text" },
            index: 1,
            type: "content_block_start",
          },
        ],
        [
          "content_block_delta",
          {
            delta: { text: "Hi", type: "text_delta" },
            index: 1,
            type: "content_block_delta",
          },
        ],
        [
          "message_delta",
          {
            delta: { stop_reason: "end_turn" },
            type: "message_delta",
            usage: { output_tokens: 5 },
          },
        ],
        ["message_stop", { type: "message_stop" }],
      ])
    );
    const reply = await createProvider("anthropic", {
      apiKey: "k",
      fetch: f.fetch,
    }).complete(request(), () => undefined);
    expect(reply.stop).toBe("end");
    expect(reply.blocks[0]).toEqual({
      data: { signature: "SIG", thinking: "plan", type: "thinking" },
      provider: "anthropic",
      type: "opaque",
    });
    expect(reply.blocks[1]).toEqual({ text: "Hi", type: "text" });
  });

  it("maps HTTP errors to kinds with plain words and never repeats the key", async () => {
    const key = "sk-ant-SECRET-123";
    const cases: [number, string, RegExp][] = [
      [401, "authentication_error", /did not accept this API key/],
      [429, "rate_limit_error", /rate limiting/],
      [529, "overloaded_error", /overloaded/],
      [400, "invalid_request_error", /refused the request/],
    ];
    for (const [status, type, words] of cases) {
      const f = fakeFetch(
        json(
          {
            error: { message: `bad key ${key}`.replace(key, "[hidden]"), type },
            type: "error",
          },
          { headers: { "retry-after": "7" }, status }
        )
      );
      // biome-ignore lint/performance/noAwaitInLoops: one status at a time, the failure names the status
      const err = await createProvider("anthropic", {
        apiKey: key,
        fetch: f.fetch,
      })
        .complete(request(), () => undefined)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentError);
      expect(explain(err)).toMatch(words);
      expect(explain(err)).not.toContain(key);
      expect((err as AgentError).status).toBe(status);
    }
  });

  it("reports a failed fetch as a network error that mentions blocking and CORS", async () => {
    const f = fakeFetch(new TypeError("Failed to fetch"));
    const err = (await createProvider("anthropic", {
      apiKey: "k",
      fetch: f.fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(err.kind).toBe("network");
    expect(explain(err)).toContain("api.anthropic.com");
    expect(explain(err)).toContain("cross-origin");
  });

  it("reports an abort as aborted", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const f = fakeFetch(abort);
    const err = (await createProvider("anthropic", {
      apiKey: "k",
      fetch: f.fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(err.kind).toBe("aborted");
  });

  it("raises an error event in the stream and a stream that ends early", async () => {
    const f1 = fakeFetch(
      sse([
        [
          "error",
          {
            error: { message: "Overloaded", type: "overloaded_error" },
            type: "error",
          },
        ],
      ])
    );
    const e1 = (await createProvider("anthropic", {
      apiKey: "k",
      fetch: f1.fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(e1.kind).toBe("overloaded");
    const f2 = fakeFetch(
      sse([
        ["message_start", { message: { usage: {} }, type: "message_start" }],
      ])
    );
    const e2 = (await createProvider("anthropic", {
      apiKey: "k",
      fetch: f2.fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(e2.kind).toBe("stream");
  });

  it("lists models across pages, hides retired ones, newest first, with image support", async () => {
    const f = fakeFetch(
      json({
        data: [
          {
            capabilities: { image_input: { supported: true } },
            created_at: "2026-01-01T00:00:00Z",
            display_name: "Old",
            id: "claude-opus-4-1",
            max_tokens: 32_000,
          },
          {
            created_at: "2025-01-01T00:00:00Z",
            id: "claude-gone",
            lifecycle: "retired",
          },
        ],
        has_more: true,
        last_id: "claude-gone",
      }),
      json({
        data: [
          {
            capabilities: { image_input: { supported: true } },
            created_at: "2026-09-01T00:00:00Z",
            display_name: "New",
            id: "claude-opus-5-5",
            max_tokens: 64_000,
          },
        ],
        has_more: false,
      })
    );
    const models = await createProvider("anthropic", {
      apiKey: "k",
      fetch: f.fetch,
    }).listModels();
    expect(models.map((m) => m.id)).toEqual([
      "claude-opus-5-5",
      "claude-opus-4-1",
    ]);
    expect(models[0]).toMatchObject({
      images: true,
      maxOutput: 64_000,
      name: "New",
    });
    expect(f.calls[0]?.url).toBe(
      "https://api.anthropic.com/v1/models?limit=100"
    );
    expect(f.calls[1]?.url).toBe(
      "https://api.anthropic.com/v1/models?limit=100&after_id=claude-gone"
    );
    expect(
      f.calls[0]?.headers["anthropic-dangerous-direct-browser-access"]
    ).toBe("true");
  });
});

describe("OpenAI request shape", () => {
  it("builds a stateless Responses API body with function tools and instructions", () => {
    const body = buildOpenAIBody(request({ model: "gpt-5" })) as Record<
      string,
      unknown
    >;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.instructions).toBe("stable part\n\nturn part");
    expect(body.tools).toEqual([
      {
        description: "Look at the project.",
        name: "list_documents",
        parameters: tools[0]?.inputSchema,
        strict: false,
        type: "function",
      },
    ]);
    expect(body).not.toHaveProperty("max_output_tokens");
  });

  it("does not ask non-reasoning models for encrypted reasoning", () => {
    expect(isReasoningModel("gpt-4.1")).toBe(false);
    expect(isReasoningModel("o3")).toBe(true);
    expect(buildOpenAIBody(request({ model: "gpt-4.1" }))).not.toHaveProperty(
      "include"
    );
  });

  it("turns messages into input items: function_call, function_call_output, then a user message with the picture", () => {
    const body = buildOpenAIBody(request({ model: "gpt-5" })) as {
      input: Record<string, unknown>[];
    };
    expect(body.input.map((i) => i.type ?? i.role)).toEqual([
      "user",
      "reasoning",
      "assistant",
      "function_call",
      "function_call_output",
      "user",
    ]);
    expect(body.input[1]).toEqual({ id: "rs_1", type: "reasoning" });
    expect(body.input[3]).toEqual({
      arguments: '{"kind":"sfx"}',
      call_id: "toolu_1",
      name: "list_documents",
      type: "function_call",
    });
    expect(body.input[4]).toEqual({
      call_id: "toolu_1",
      output: "sfx/coin",
      type: "function_call_output",
    });
    const last = body.input[5] as { content: Record<string, unknown>[] };
    expect(last.content.map((c) => c.type)).toEqual([
      "input_text",
      "input_image",
      "input_text",
    ]);
    expect(last.content[1]).toMatchObject({
      image_url: "data:image/png;base64,AAAA",
    });
  });
});

describe("OpenAI calls", () => {
  it("POSTs to /v1/responses with a bearer key and parses text deltas and the completed output", async () => {
    const output = [
      { id: "rs_1", summary: [], type: "reasoning" },
      {
        content: [{ text: "Checking.", type: "output_text" }],
        id: "msg_1",
        role: "assistant",
        type: "message",
      },
      {
        arguments: '{"kind":"song"}',
        call_id: "call_1",
        id: "fc_1",
        name: "list_documents",
        type: "function_call",
      },
    ];
    const f = fakeFetch(
      sse([
        ["response.created", { response: {}, type: "response.created" }],
        [
          "response.output_text.delta",
          { delta: "Check", type: "response.output_text.delta" },
        ],
        [
          "response.output_text.delta",
          { delta: "ing.", type: "response.output_text.delta" },
        ],
        [
          "response.completed",
          {
            response: {
              output,
              status: "completed",
              usage: { input_tokens: 5, output_tokens: 7 },
            },
            type: "response.completed",
          },
        ],
      ])
    );
    const text: string[] = [];
    const reply = await createProvider("openai", {
      apiKey: "sk-openai-test",
      fetch: f.fetch,
    }).complete(request({ model: "gpt-5" }), (d) => text.push(d));
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-openai-test");
    expect(f.calls[0]?.headers).not.toHaveProperty(
      "anthropic-dangerous-direct-browser-access"
    );
    expect(text.join("")).toBe("Checking.");
    expect(reply.stop).toBe("tool_use");
    expect(reply.usage).toEqual({ input: 5, output: 7 });
    expect(reply.blocks).toEqual([
      { data: output[0], provider: "openai", type: "opaque" },
      { text: "Checking.", type: "text" },
      {
        id: "call_1",
        input: { kind: "song" },
        name: "list_documents",
        type: "tool_call",
      },
    ]);
  });

  it("ends the turn when there is no function call, and reports an incomplete reply as max_tokens", async () => {
    const done = fakeFetch(
      sse([
        [
          "response.completed",
          {
            response: {
              output: [
                {
                  content: [{ text: "Hi", type: "output_text" }],
                  type: "message",
                },
              ],
            },
            type: "response.completed",
          },
        ],
      ])
    );
    const r1 = await createProvider("openai", {
      apiKey: "k",
      fetch: done.fetch,
    }).complete(request(), () => undefined);
    expect(r1.stop).toBe("end");
    const cut = fakeFetch(
      sse([
        [
          "response.incomplete",
          {
            response: {
              incomplete_details: { reason: "max_output_tokens" },
              output: [],
            },
            type: "response.incomplete",
          },
        ],
      ])
    );
    const r2 = await createProvider("openai", {
      apiKey: "k",
      fetch: cut.fetch,
    }).complete(request(), () => undefined);
    expect(r2.stop).toBe("max_tokens");
  });

  it("maps errors: 401, 429, a failed response and a stream error event", async () => {
    const e401 = (await createProvider("openai", {
      apiKey: "k",
      fetch: fakeFetch(
        json(
          {
            error: {
              code: "invalid_api_key",
              message: "Incorrect API key provided: sk-...abcd",
            },
          },
          { status: 401 }
        )
      ).fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(e401.kind).toBe("auth");
    expect(explain(e401)).toContain("OpenAI did not accept this API key");
    const e429 = (await createProvider("openai", {
      apiKey: "k",
      fetch: fakeFetch(json({ error: { message: "quota" } }, { status: 429 }))
        .fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(e429.kind).toBe("rate_limit");
    const failed = (await createProvider("openai", {
      apiKey: "k",
      fetch: fakeFetch(
        sse([
          [
            "response.failed",
            {
              response: { error: { code: "server_error", message: "boom" } },
              type: "response.failed",
            },
          ],
        ])
      ).fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(failed.kind).toBe("server");
    const evt = (await createProvider("openai", {
      apiKey: "k",
      fetch: fakeFetch(
        sse([
          [
            "error",
            {
              code: "rate_limit_exceeded",
              message: "slow down",
              type: "error",
            },
          ],
        ])
      ).fetch,
    })
      .complete(request(), () => undefined)
      .catch((e: unknown) => e)) as AgentError;
    expect(evt.kind).toBe("rate_limit");
  });

  it("lists chat models only, newest first", async () => {
    const f = fakeFetch(
      json({
        data: [
          { created: 100, id: "gpt-5" },
          { created: 300, id: "text-embedding-3-large" },
          { created: 200, id: "gpt-4o-realtime-preview" },
          { created: 150, id: "gpt-4.1" },
          { created: 90, id: "whisper-1" },
          { created: 400, id: "gpt-5-mini" },
        ],
      })
    );
    const models = await createProvider("openai", {
      apiKey: "sk-o",
      fetch: f.fetch,
    }).listModels();
    expect(models.map((m) => m.id)).toEqual(["gpt-5-mini", "gpt-4.1", "gpt-5"]);
    expect(f.calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-o");
  });
});
