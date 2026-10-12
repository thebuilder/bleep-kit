// @vitest-environment node
/* Where the assistant's API key is kept: "Remember on this device" means localStorage, otherwise sessionStorage, never
   both, and Forget clears both. A storage that throws must not break anything. */
import { describe, expect, it } from "vitest";
import { createSettings, type StorageLike } from "../src/assistant/settings.ts";
import { createHistory, GROUP_PREFIX } from "../src/lib/history.ts";

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    removeItem: (k) => {
      data.delete(k);
    },
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const KEY = "sk-ant-test-key-1234567890";

function setup() {
  const local = memoryStorage();
  const session = memoryStorage();
  const settings = createSettings({
    local: () => local,
    session: () => session,
  });
  return { local, session, settings };
}

const holds = (s: ReturnType<typeof memoryStorage>, text: string) =>
  [...s.data.values()].some((v) => v.includes(text));

describe("the key's storage", () => {
  it("keeps the key in localStorage only when asked to remember it", () => {
    const { local, session, settings } = setup();
    settings.saveKey("anthropic", KEY, true);
    expect(holds(local, KEY)).toBe(true);
    expect(holds(session, KEY)).toBe(false);
    expect(settings.keyOf("anthropic")).toBe(KEY);
    expect(settings.placeOf("anthropic")).toBe("device");
  });

  it("keeps the key in sessionStorage by default", () => {
    const { local, session, settings } = setup();
    settings.saveKey("anthropic", KEY, false);
    expect(holds(session, KEY)).toBe(true);
    expect(holds(local, KEY)).toBe(false);
    expect(settings.placeOf("anthropic")).toBe("session");
  });

  it("moves the key when the choice changes, leaving no copy behind", () => {
    const { local, session, settings } = setup();
    settings.saveKey("openai", KEY, true);
    settings.saveKey("openai", KEY, false);
    expect(holds(local, KEY)).toBe(false);
    expect(holds(session, KEY)).toBe(true);
    settings.saveKey("openai", KEY, true);
    expect(holds(session, KEY)).toBe(false);
    expect(holds(local, KEY)).toBe(true);
  });

  it("keeps one key per provider", () => {
    const { settings } = setup();
    settings.saveKey("anthropic", "sk-ant-aaaaaaaa", false);
    settings.saveKey("openai", "sk-bbbbbbbb", true);
    expect(settings.keyOf("anthropic")).toBe("sk-ant-aaaaaaaa");
    expect(settings.keyOf("openai")).toBe("sk-bbbbbbbb");
    settings.forgetKey("openai");
    expect(settings.keyOf("openai")).toBe("");
    expect(settings.keyOf("anthropic")).toBe("sk-ant-aaaaaaaa");
  });

  it("forgets a key from both storages and tells subscribers", () => {
    const { local, session, settings } = setup();
    let told = 0;
    settings.subscribe(() => {
      told += 1;
    });
    settings.saveKey("anthropic", KEY, true);
    session.setItem("bleepkit:assistant:key:anthropic", KEY);
    settings.forgetKey("anthropic");
    expect(holds(local, KEY)).toBe(false);
    expect(holds(session, KEY)).toBe(false);
    expect(settings.keyOf("anthropic")).toBe("");
    expect(settings.placeOf("anthropic")).toBeNull();
    expect(told).toBe(2);
  });

  it("never writes the key into the saved choices", () => {
    const { local, session, settings } = setup();
    settings.saveKey("anthropic", KEY, true);
    settings.saveChoices({
      models: { anthropic: "claude-opus-test" },
      provider: "anthropic",
      remember: true,
    });
    const choices = local.data.get("bleepkit:assistant:choices") ?? "";
    expect(choices).toContain("claude-opus-test");
    expect(choices).not.toContain(KEY);
    expect(holds(session, KEY)).toBe(false);
  });

  it("remembers provider, model per provider and the remember choice", () => {
    const { local, session, settings } = setup();
    settings.saveChoices({
      models: { anthropic: "a1" },
      provider: "openai",
      remember: true,
    });
    settings.saveChoices({ models: { openai: "o1" } });
    const again = createSettings({
      local: () => local,
      session: () => session,
    });
    expect(again.choices()).toEqual({
      models: { anthropic: "a1", openai: "o1" },
      provider: "openai",
      remember: true,
    });
  });

  it("works for the visit when the storage refuses everything", () => {
    const broken: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const settings = createSettings({
      local: () => broken,
      session: () => null,
    });
    settings.saveKey("anthropic", KEY, true);
    expect(settings.keyOf("anthropic")).toBe(KEY);
    settings.saveChoices({ provider: "anthropic" });
    expect(settings.choices().provider).toBe("anthropic");
    settings.forgetKey("anthropic");
    expect(settings.keyOf("anthropic")).toBe("");
  });

  it("ignores damaged saved choices", () => {
    const { local, session } = setup();
    local.setItem("bleepkit:assistant:choices", "{not json");
    const settings = createSettings({
      local: () => local,
      session: () => session,
    });
    expect(settings.choices()).toEqual({
      models: {},
      provider: "anthropic",
      remember: false,
    });
  });
});

describe("one assistant turn is one undo step", () => {
  const key = `${GROUP_PREFIX}assistant-1`;

  it("merges grouped edits however far apart in time", () => {
    const h = createHistory();
    h.reset("a");
    h.push("b", key, 0);
    h.push("c", key, 60_000);
    h.push("d", key, 120_000);
    expect(h.undo()).toBe("a");
    expect(h.canUndo).toBe(false);
    expect(h.redo()).toBe("d");
  });

  it("starts a new step for the next turn and for the person's own edits", () => {
    const h = createHistory();
    h.reset("a");
    h.push("b", key, 0);
    h.push("c", `${GROUP_PREFIX}assistant-2`, 10);
    h.push("d", "slider", 20);
    expect(h.undo()).toBe("c");
    expect(h.undo()).toBe("b");
    expect(h.undo()).toBe("a");
  });

  it("still merges plain keys only within the short window", () => {
    const h = createHistory();
    h.reset("a");
    h.push("b", "vol", 0);
    h.push("c", "vol", 100);
    h.push("d", "vol", 5000);
    expect(h.undo()).toBe("c");
    expect(h.undo()).toBe("a");
  });
});
