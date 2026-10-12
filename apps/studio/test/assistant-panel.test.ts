/* The assistant in the real shell on the fake engine: the drawer, the settings dialog, a conversation against a stubbed
   Anthropic API (no network), the stop button, and the words for a rejected key. */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  anthropicStub,
  type Call,
  toolUse,
  words,
} from "./assistant-fixtures.ts";
import { installCanvasStub, settle, until } from "./helpers.ts";

installCanvasStub();
vi.setConfig({ hookTimeout: 30_000, testTimeout: 5000 });

const KEY = "sk-ant-test-0123456789";
const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;
const press = (el: Element | null) => {
  expect(el).not.toBeNull();
  (el as HTMLElement).click();
};
const key = (k: string, mods: KeyboardEventInit = {}) =>
  document.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, key: k, ...mods })
  );
const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
};
const logText = () => $("#asst .asst-log").textContent ?? "";
const open = () => !$("#asst").hidden;

let calls: Call[] = [];
const stubWith = (...replies: (() => Response)[]) => {
  const stub = anthropicStub(replies);
  ({ calls } = stub);
  vi.stubGlobal("fetch", stub.fetch);
};

beforeAll(async () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  (
    window as unknown as { happyDOM?: { setURL: (url: string) => void } }
  ).happyDOM?.setURL("http://localhost:3000/?engine=fake&store=local#/pads");
  document.body.innerHTML =
    '<canvas id="backdrop"></canvas><div id="app"></div>';
  const { boot } = await import("../src/shell.ts");
  await boot($("#app"));
  await until(() => document.querySelectorAll(".pad[data-id]").length > 0);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});

afterAll(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/** Open the settings from the project menu, type the key and wait for the model list. */
async function enterKey(remember: boolean) {
  press($("#projMenuBtn"));
  press($('.pmenu-item[data-action="assistant-settings"]'));
  expect($(".asst-modal")).not.toBeNull();
  type($("#asstKey"), KEY);
  press($("#asstCheck"));
  expect(
    await until(() => ($("#asstStatus").textContent ?? "").includes("accepted"))
  ).toBe(true);
  $<HTMLInputElement>("#asstRemember").checked = remember;
  $("#asstRemember").dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the drawer", () => {
  it("starts closed, opens with Ctrl+J and the top bar button, and shows the setup state without a key", () => {
    expect(open()).toBe(false);
    key("j", { ctrlKey: true });
    expect(open()).toBe(true);
    expect(document.body.classList.contains("asst-open")).toBe(true);
    expect($("#bAsst").getAttribute("aria-pressed")).toBe("true");
    expect($("#asst").textContent).toContain("Set up the assistant");
    expect($("#asst").textContent).toContain(
      "Your key stays in this browser; requests go straight to the provider and are billed to your account."
    );
    expect($<HTMLTextAreaElement>(".asst-in").disabled).toBe(true);
    press($("#bAsst"));
    expect(open()).toBe(false);
    expect($("#bAsst").getAttribute("aria-pressed")).toBe("false");
  });

  it("is in the command palette next to its settings", () => {
    press($("#bPal"));
    const input = $<HTMLInputElement>(".overlay input");
    type(input, "assistant");
    const titles = [...document.querySelectorAll(".cmd .nm")].map(
      (n) => n.textContent
    );
    expect(titles).toContain("Show or hide the assistant");
    expect(titles).toContain("Assistant settings: API key and model");
    key("Escape");
  });
});

describe("the settings dialog", () => {
  it("lists the models once the key is typed, picks the newest top model, and talks only to the provider", async () => {
    stubWith();
    await enterKey(true);
    const options = [...document.querySelectorAll("#asstModel option")].map(
      (o) => (o as HTMLOptionElement).value
    );
    expect(options).toEqual(["claude-opus-test", "claude-sonnet-test"]);
    expect($<HTMLSelectElement>("#asstModel").value).toBe("claude-opus-test");
    const models = calls.find((c) => c.url.includes("/v1/models"));
    expect(models?.url.startsWith("https://api.anthropic.com/")).toBe(true);
    expect(models?.headers["x-api-key"]).toBe(KEY);
    expect(models?.headers["anthropic-dangerous-direct-browser-access"]).toBe(
      "true"
    );
    // the key field is a password field until Show is pressed
    expect($<HTMLInputElement>("#asstKey").type).toBe("password");
    press($("#asstShow"));
    expect($<HTMLInputElement>("#asstKey").type).toBe("text");
    press($("#asstShow"));
    expect($<HTMLInputElement>("#asstKey").type).toBe("password");
    press($("#asstSave"));
    expect($(".asst-modal")).toBeNull();
    expect(Object.values(localStorage).join("")).toContain(KEY);
    expect(Object.values(sessionStorage).join("")).not.toContain(KEY);
    for (const c of calls) {
      expect(c.url.startsWith("https://api.anthropic.com/")).toBe(true);
    }
  });

  it("keeps the key for the session only when Remember is off, and forgets it on request", async () => {
    stubWith();
    press($("#projMenuBtn"));
    press($('.pmenu-item[data-action="assistant-settings"]'));
    expect(
      await until(() =>
        ($("#asstStatus").textContent ?? "").includes("accepted")
      )
    ).toBe(true);
    $<HTMLInputElement>("#asstRemember").checked = false;
    $("#asstRemember").dispatchEvent(new Event("change", { bubbles: true }));
    press($("#asstSave"));
    expect(Object.values(localStorage).join("")).not.toContain(KEY);
    expect(Object.values(sessionStorage).join("")).toContain(KEY);
    press($("#asstGear"));
    expect(
      await until(() =>
        ($("#asstStatus").textContent ?? "").includes("accepted")
      )
    ).toBe(true);
    press($("#asstForget"));
    expect($<HTMLInputElement>("#asstKey").value).toBe("");
    expect(Object.values(localStorage).join("")).not.toContain(KEY);
    expect(Object.values(sessionStorage).join("")).not.toContain(KEY);
    key("Escape");
    expect($(".asst-modal")).toBeNull();
  });

  it("says in plain words when the key is rejected", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: "invalid x-api-key" } }),
          {
            status: 401,
          }
        )
      )
    );
    press($("#projMenuBtn"));
    press($('.pmenu-item[data-action="assistant-settings"]'));
    type($("#asstKey"), "sk-ant-wrong-0000000");
    press($("#asstCheck"));
    expect(
      await until(() => ($("#asstStatus").textContent ?? "").includes("401"))
    ).toBe(true);
    expect($("#asstStatus").dataset.tone).toBe("bad");
    expect($<HTMLButtonElement>("#asstSave").disabled).toBe(true);
    key("Escape");
  });
});

describe("a conversation", () => {
  async function ready() {
    stubWith();
    await enterKey(false);
    press($("#asstSave"));
    if (!open()) {
      key("j", { ctrlKey: true });
    }
  }

  it("offers the starting suggestions in a fresh conversation", async () => {
    await ready();
    expect(
      [...document.querySelectorAll(".asst-chip")].map((c) => c.textContent)
    ).toEqual([
      "Make a coin sound for the NES",
      "Write a 16-bar Game Boy town theme",
      "Make the bass in this song fuller",
    ]);
    expect($<HTMLTextAreaElement>(".asst-in").disabled).toBe(false);
  });

  it("streams a reply with a compact tool line, and the next request carries the tool result", async () => {
    stubWith(
      () => toolUse("Let me look. ", "list_documents", { kind: "sfx" }),
      () => words("You have **a coin** sound.")
    );
    press(document.querySelector(".asst-chip"));
    expect(
      await until(
        () =>
          !$("#asst .asst-form").dataset.busy?.includes("true") &&
          logText().includes("a coin")
      )
    ).toBe(true);
    expect($(".am.user").textContent).toBe("Make a coin sound for the NES");
    const tool = $(".am.tool");
    expect(tool.textContent).toContain("list_documents");
    expect(tool.dataset.state).toBe("ok");
    expect($(".am.bot strong").textContent).toBe("a coin");
    expect($(".asst-chips").hidden).toBe(true);
    const posts = calls.filter((c) => c.url.endsWith("/v1/messages"));
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[1]?.body)).toContain("tool_result");
    // the project and the open document are told to the model
    expect(JSON.stringify(posts[0]?.body)).toContain("RIGHT NOW");
  });

  it("shows the words for a rate limit and keeps the conversation usable", async () => {
    stubWith(
      () =>
        new Response(JSON.stringify({ error: { message: "slow down" } }), {
          headers: { "retry-after": "7" },
          status: 429,
        })
    );
    type($(".asst-in"), "hello again");
    press($('#asst .asst-form button[type="submit"]'));
    expect(await until(() => logText().includes("rate limiting"))).toBe(true);
    expect(logText()).toContain("429");
    expect(logText()).toContain("7 seconds");
    expect(
      $('#asst .asst-form button[type="submit"]').getAttribute("aria-label")
    ).toBe("Send");
  });

  it("stops on the stop button", async () => {
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          seen = init?.signal as AbortSignal;
          seen.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError"))
          );
        })
    );
    type($(".asst-in"), "something slow");
    press($('#asst .asst-form button[type="submit"]'));
    expect(await until(() => seen !== undefined)).toBe(true);
    const button = $('#asst .asst-form button[type="submit"]');
    expect(button.getAttribute("aria-label")).toBe("Stop");
    press(button);
    expect(await until(() => logText().includes("Stopped."))).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Send");
  });

  it("starts over with New conversation", () => {
    press($('#asst button[aria-label="New conversation"]'));
    expect(document.querySelector(".am")).toBeNull();
    expect($(".asst-chips").hidden).toBe(false);
  });

  it("goes back to the setup state when the key is forgotten", async () => {
    stubWith();
    press($("#asstGear"));
    expect(
      await until(() =>
        ($("#asstStatus").textContent ?? "").includes("accepted")
      )
    ).toBe(true);
    press($("#asstForget"));
    key("Escape");
    expect($("#asst").textContent).toContain("Set up the assistant");
    await settle(5);
  });
});
