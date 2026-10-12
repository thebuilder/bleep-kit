import { describe, expect, it } from "vitest";
import {
  applyChanges,
  baseSystemPrompt,
  buildSystem,
  checkInput,
  FORMAT_SECTIONS,
  FORMAT_TEXT,
  getAt,
  type ModelInfo,
  parseRef,
  pickDefaultModel,
  readSse,
  turnContext,
} from "../src/index.ts";

const stream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) {
        c.enqueue(ch);
      }
      c.close();
    },
  });

async function collect(body: ReadableStream<Uint8Array>) {
  const out: { data: string; event: string | null }[] = [];
  for await (const e of readSse(body)) {
    out.push(e);
  }
  return out;
}

describe("readSse", () => {
  const text =
    'event: a\ndata: {"x":"héllo"}\n\n: comment\nevent: b\ndata: 1\ndata: 2\n\ndata: tail\n\n';

  it("parses events whatever the chunking, including a split multi-byte character", async () => {
    const bytes = new TextEncoder().encode(text);
    const expected = [
      { data: '{"x":"héllo"}', event: "a" },
      { data: "1\n2", event: "b" },
      { data: "tail", event: null },
    ];
    for (const size of [1, 2, 3, 7, bytes.length]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) {
        chunks.push(bytes.slice(i, i + size));
      }
      // biome-ignore lint/performance/noAwaitInLoops: one chunk size at a time, the failure names the size
      expect(await collect(stream(chunks))).toEqual(expected);
    }
  });

  it("handles CRLF line ends and a final event without a blank line", async () => {
    const bytes = new TextEncoder().encode(
      "event: x\r\ndata: 1\r\n\r\ndata: 2"
    );
    const chunks = [bytes.slice(0, 15), bytes.slice(15)];
    expect(await collect(stream(chunks))).toEqual([
      { data: "1", event: "x" },
      { data: "2", event: null },
    ]);
  });
});

describe("checkInput", () => {
  it("accepts good input and lists every problem otherwise", () => {
    const schema = {
      properties: {
        list: { items: { type: "string" }, maxItems: 2, type: "array" },
        n: { maximum: 3, minimum: 1, type: "integer" },
        s: { enum: ["a", "b"], type: "string" },
      },
      required: ["n"],
      type: "object",
    } as const;
    expect(checkInput({ list: ["x"], n: 2, s: "a" }, schema)).toEqual({
      ok: true,
      value: { list: ["x"], n: 2, s: "a" },
    });
    const bad = checkInput({ list: ["x", 1, "z"], n: 5.5, s: "c" }, schema);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.join("\n")).toContain("n: must be a whole number");
      expect(bad.errors.join("\n")).toContain("s: must be one of a, b");
      expect(bad.errors.join("\n")).toContain("list: allows at most 2 items");
      expect(bad.errors.join("\n")).toContain("list/1: must be a string");
    }
    expect(checkInput({}, schema).ok).toBe(false);
  });
});

describe("pointer", () => {
  it("edits a copy and explains failures", () => {
    const doc = { a: { b: [1, 2, 3] }, "x/y": 1 };
    const r = applyChanges(doc, [
      { op: "set", path: "/a/b/1", value: 9 },
      { op: "set", path: "/a/b/-", value: 4 },
      { op: "remove", path: "/a/b/0" },
      { op: "set", path: "/x~1y", value: 2 },
    ]);
    expect(r).toEqual({ ok: true, value: { a: { b: [9, 3, 4] }, "x/y": 2 } });
    expect(doc.a.b).toEqual([1, 2, 3]);
    const bad = applyChanges(doc, [{ op: "set", path: "/a/b/7", value: 1 }]);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toContain("outside the array");
    expect(getAt(doc, "/a/z/q").ok).toBe(false);
    expect(parseRef("sfx/Coin")).toContain("not a valid id");
  });
});

describe("system prompt", () => {
  const prompt = baseSystemPrompt();

  it("embeds the CLI's format reference verbatim, so the two cannot drift", () => {
    for (const section of FORMAT_SECTIONS) {
      expect(prompt).toContain(FORMAT_TEXT[section]);
    }
  });

  it("teaches the measuring workflow, the targets, the deafness and the chips", () => {
    expect(prompt).toContain("YOU CANNOT HEAR");
    expect(prompt).toContain("-14 to -16 LUFS");
    expect(prompt).toContain("between -6 and -16 dBFS");
    expect(prompt).toContain("render_analyze");
    expect(prompt).toContain("pulse1:pulse");
    expect(prompt).toContain("genesis: fm1:fm");
  });

  it("says that deleting must be mentioned", () => {
    expect(prompt).toContain("If you delete anything, say so plainly");
  });

  it("never uses the em dash character", () => {
    expect(prompt).not.toContain("\u2014");
  });

  it("is one fixed part, with the open document in the turn context instead", () => {
    expect(buildSystem()).toEqual([prompt]);
    const state: Parameters<typeof turnContext>[0] = {
      current: { id: "coin", kind: "sfx" },
      project: {
        chip: "nes",
        master: { limiter: true, volume: 0.8 },
        name: "Demo",
        sampleRate: 48_000,
        seed: 7,
      },
    };
    const text = turnContext(state);
    expect(text).toContain("sfx/coin open");
    expect(text).toContain('"Demo" on the nes chip');
    expect(prompt).not.toContain('"Demo" on the nes chip');
  });
});

describe("default model", () => {
  const m = (
    id: string,
    created: number,
    images: boolean | null = null
  ): ModelInfo => ({ created, id, images, maxOutput: null, name: id });

  it("prefers the newest opus that takes images, then sonnet, then anything", () => {
    const list = [
      m("claude-sonnet-5-5", 300, true),
      m("claude-opus-4-6", 100, true),
      m("claude-opus-5-5", 200, true),
      m("claude-opus-9", 400, false),
    ];
    expect(pickDefaultModel("anthropic", list)?.id).toBe("claude-opus-5-5");
    expect(
      pickDefaultModel(
        "anthropic",
        list.filter((x) => !x.id.includes("opus"))
      )?.id
    ).toBe("claude-sonnet-5-5");
    expect(pickDefaultModel("anthropic", [m("claude-x", 1)])?.id).toBe(
      "claude-x"
    );
    expect(pickDefaultModel("anthropic", [])).toBeUndefined();
  });

  it("picks the highest plain gpt for OpenAI, not a mini or a dated snapshot", () => {
    const list = [
      m("gpt-5-mini", 900),
      m("gpt-5.1", 500),
      m("gpt-5", 400),
      m("gpt-5.1-2026-01-01", 800),
      m("gpt-4.1", 100),
    ];
    expect(pickDefaultModel("openai", list)?.id).toBe("gpt-5.1");
    expect(
      pickDefaultModel("openai", [m("o3", 5), m("gpt-4o-mini", 4)])?.id
    ).toBe("o3");
  });
});
