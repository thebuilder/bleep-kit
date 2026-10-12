// @vitest-environment node
/* The assistant session against a stubbed Anthropic API: what a conversation sends has to stay byte for byte the same
   from one turn to the next (system prompt, tools, every earlier message), because the API binds each thinking block's
   signature to all of it and refuses a conversation whose past changed. */
import type { Message, ProviderId } from "@bleepkit/agent";
import { createProvider } from "@bleepkit/agent";
import { describe, expect, it } from "vitest";
import type { StudioHost } from "../src/assistant/host.ts";
import { AssistantSession } from "../src/assistant/session.ts";
import { createSettings, type StorageLike } from "../src/assistant/settings.ts";
import { anthropicStub, thinking, words } from "./assistant-fixtures.ts";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

interface Body {
  messages: {
    content: { type: string; [k: string]: unknown }[];
    role: string;
  }[];
  system: unknown;
  tools: unknown;
}

/** The part of the studio the session touches: which document is open, and what the project is. */
function fakeHost() {
  const state = {
    current: { id: "coin", kind: "sfx" } as { id: string; kind: string } | null,
    master: 0.8,
  };
  const host = {
    beginTurn: () => undefined,
    current: () => state.current,
    endTurn: () => undefined,
    project: () =>
      Promise.resolve({
        chip: "nes",
        master: { limiter: true, volume: state.master },
        name: "Demo",
        sampleRate: 48_000,
        seed: 7,
      }),
  } as unknown as StudioHost;
  return { host, state };
}

function setup(replies: (() => Response)[]) {
  const stub = anthropicStub(replies);
  const settings = createSettings({
    local: () => memoryStorage(),
    session: () => memoryStorage(),
  });
  settings.saveKey("anthropic", "sk-ant-test-0123456789", false);
  settings.saveChoices({
    models: { anthropic: "claude-opus-test" },
    provider: "anthropic",
  });
  const { host, state } = fakeHost();
  const session = new AssistantSession(
    host,
    settings,
    (id: ProviderId, apiKey: string) =>
      createProvider(id, { apiKey, fetch: stub.fetch })
  );
  const sent = (): Body[] =>
    stub.calls
      .filter((c) => c.url.endsWith("/v1/messages"))
      .map((c) => c.body as Body);
  return { sent, session, settings, state, stub };
}

const json = (v: unknown): string => JSON.stringify(v);

describe("a conversation's request prefix", () => {
  it("is byte-identical in the second turn after the open document, the page and the project changed", async () => {
    const { sent, session, state } = setup([
      () => thinking("sig-one", { text: "Made it." }),
      () => thinking("sig-two", { text: "Changed it." }),
    ]);
    await session.send("make a coin");
    state.current = { id: "title", kind: "song" };
    state.master = 0.5;
    await session.send("now the title song");
    const [first, second] = sent();
    expect(sent()).toHaveLength(2);
    if (!(first && second)) {
      throw new Error("two requests expected");
    }
    // the system prompt and the tools never change
    expect(json(second.system)).toBe(json(first.system));
    expect(json(second.tools)).toBe(json(first.tools));
    expect(json(first.system)).not.toContain("Demo");
    expect(json(first.system)).not.toContain("has sfx/coin open");
    // everything the first request sent comes back unchanged, at the start of the second
    expect(first.messages).toHaveLength(1);
    expect(second.messages).toHaveLength(3);
    expect(json(second.messages[0])).toBe(json(first.messages[0]));
    // the assistant's first reply is replayed exactly as received: thinking block with its signature, then the text
    expect(second.messages[1]).toEqual({
      content: [
        { signature: "sig-one", thinking: "", type: "thinking" },
        { text: "Made it.", type: "text" },
      ],
      role: "assistant",
    });
    // what changed is in the new user message only
    expect(json(second.messages[2])).toContain("song/title");
    expect(json(second.messages[2])).toContain("master volume 0.5");
    expect(json(first.messages[0])).toContain("sfx/coin");
  });

  it("stays the same across the steps of a tool turn and into the next turn", async () => {
    const { sent, session, state } = setup([
      () => thinking("sig-a", { id: "toolu_1", input: {}, name: "stop" }),
      () => thinking("sig-b", { text: "Stopped." }),
      () => words("Anything else?"),
    ]);
    await session.send("stop the music");
    state.current = null;
    await session.send("thanks");
    const [a, b, c] = sent();
    if (!(a && b && c)) {
      throw new Error("three requests expected");
    }
    for (const later of [b, c]) {
      expect(json(later.system)).toBe(json(a.system));
      expect(json(later.tools)).toBe(json(a.tools));
    }
    expect(json(b.messages.slice(0, 1))).toBe(json(a.messages));
    expect(json(c.messages.slice(0, b.messages.length + 1))).toBe(
      json([
        ...b.messages,
        {
          content: [
            { signature: "sig-b", thinking: "", type: "thinking" },
            { text: "Stopped.", type: "text" },
          ],
          role: "assistant",
        },
      ])
    );
  });

  it("forgets the thinking blocks and asks again when the API still says a signature is bound to another conversation", async () => {
    const refusal = () =>
      new Response(
        JSON.stringify({
          error: {
            message:
              'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the `thinking-binding-controls-2026-08-01` value in the `anthropic-beta` header.',
            type: "invalid_request_error",
          },
          type: "error",
        }),
        { status: 400 }
      );
    const { sent, session } = setup([
      () => thinking("sig-one", { text: "First." }),
      refusal,
      () => words("Second, without the old thinking."),
    ]);
    await session.send("one");
    await session.send("two");
    const [, refused, retried] = sent();
    expect(json(refused?.messages)).toContain("sig-one");
    expect(json(retried?.messages)).not.toContain("thinking");
    expect(session.entries.some((e) => e.type === "notice")).toBe(false);
    // the history was fixed for good: a third turn does not hit the refusal again
    const kept = (session as unknown as { messages: Message[] }).messages;
    expect(json(kept)).not.toContain("sig-one");
  });
});

describe("choosing a model while the default is being looked up", () => {
  it("leaves the person's pick alone", async () => {
    const { session, settings } = setup([]);
    settings.saveChoices({ models: { anthropic: "" } });
    const pending = session.ensureModel();
    // the person picks a model before the list comes back
    settings.saveChoices({ models: { anthropic: "claude-sonnet-test" } });
    await pending;
    expect(settings.choices().models.anthropic).toBe("claude-sonnet-test");
  });
});
