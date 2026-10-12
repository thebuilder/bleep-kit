/* A stand-in for api.anthropic.com for the assistant tests: the models list and a script of streamed replies. Nothing
   here touches the network. */

export interface Call {
  body: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

const sse = (events: [string, unknown][]): Response =>
  new Response(
    events
      .map(
        ([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );

const start: [string, unknown] = [
  "message_start",
  {
    message: { usage: { input_tokens: 10, output_tokens: 1 } },
    type: "message_start",
  },
];

const textBlock = (index: number, text: string): [string, unknown][] => [
  [
    "content_block_start",
    {
      content_block: { text: "", type: "text" },
      index,
      type: "content_block_start",
    },
  ],
  ...text.split(/(?<= )/).map((piece): [string, unknown] => [
    "content_block_delta",
    {
      delta: { text: piece, type: "text_delta" },
      index,
      type: "content_block_delta",
    },
  ]),
  ["content_block_stop", { index, type: "content_block_stop" }],
];

const stop = (reason: string): [string, unknown][] => [
  [
    "message_delta",
    {
      delta: { stop_reason: reason, stop_sequence: null },
      type: "message_delta",
      usage: { output_tokens: 20 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
];

/** A reply that is only words. */
export const words = (text: string): Response =>
  sse([start, ...textBlock(0, text), ...stop("end_turn")]);

/** A reply that says something and then asks for one tool. */
export function toolUse(
  text: string,
  name: string,
  input: unknown,
  id = "toolu_1"
): Response {
  return sse([
    start,
    ...(text ? textBlock(0, text) : []),
    [
      "content_block_start",
      {
        content_block: { id, input: {}, name, type: "tool_use" },
        index: 1,
        type: "content_block_start",
      },
    ],
    [
      "content_block_delta",
      {
        delta: {
          partial_json: JSON.stringify(input),
          type: "input_json_delta",
        },
        index: 1,
        type: "content_block_delta",
      },
    ],
    ["content_block_stop", { index: 1, type: "content_block_stop" }],
    ...stop("tool_use"),
  ]);
}

/** A reply that thinks first (the thinking text is omitted, as newer models do by default; the signature is sent), then
 *  either says something or asks for one tool. */
export function thinking(
  signature: string,
  then: { text: string } | { id: string; input: unknown; name: string }
): Response {
  const block: [string, unknown][] = [
    [
      "content_block_start",
      {
        content_block: { signature: "", thinking: "", type: "thinking" },
        index: 0,
        type: "content_block_start",
      },
    ],
    [
      "content_block_delta",
      {
        delta: { signature, type: "signature_delta" },
        index: 0,
        type: "content_block_delta",
      },
    ],
    ["content_block_stop", { index: 0, type: "content_block_stop" }],
  ];
  if ("text" in then) {
    return sse([
      start,
      ...block,
      ...textBlock(1, then.text),
      ...stop("end_turn"),
    ]);
  }
  return sse([
    start,
    ...block,
    [
      "content_block_start",
      {
        content_block: {
          id: then.id,
          input: {},
          name: then.name,
          type: "tool_use",
        },
        index: 1,
        type: "content_block_start",
      },
    ],
    [
      "content_block_delta",
      {
        delta: {
          partial_json: JSON.stringify(then.input),
          type: "input_json_delta",
        },
        index: 1,
        type: "content_block_delta",
      },
    ],
    ["content_block_stop", { index: 1, type: "content_block_stop" }],
    ...stop("tool_use"),
  ]);
}

const MODELS = [
  {
    capabilities: { image_input: { supported: true } },
    created_at: "2026-05-01T00:00:00Z",
    display_name: "Claude Opus Test",
    id: "claude-opus-test",
    max_tokens: 32_000,
    type: "model",
  },
  {
    capabilities: { image_input: { supported: true } },
    created_at: "2026-02-01T00:00:00Z",
    display_name: "Claude Sonnet Test",
    id: "claude-sonnet-test",
    max_tokens: 32_000,
    type: "model",
  },
];

const modelsReply = (): Response =>
  Response.json({ data: MODELS, has_more: false });

/** A fetch that answers the models endpoint and hands out `replies` one by one to message requests. */
export function anthropicStub(replies: (() => Response)[] = []) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
      method: init?.method ?? "GET",
      url,
    });
    if (url.includes("/v1/models")) {
      return Promise.resolve(modelsReply());
    }
    const next = queue.shift();
    return Promise.resolve(
      next
        ? next()
        : new Response(
            JSON.stringify({ error: { message: "no scripted reply" } }),
            {
              status: 500,
            }
          )
    );
  }) as typeof fetch;
  return { calls, fetch: fn };
}
