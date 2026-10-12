/* The assistant drawer on the right of the studio: the conversation with streamed replies, one compact line per tool
   call (with thumbnails of any picture the assistant looked at), a stop button while it works, suggestion chips for a
   fresh conversation, the document it is working on, and a setup card until there is an API key. */
import { explain, PROVIDER_LABELS } from "@bleepkit/agent";
import { app } from "../app.ts";
import { choose, fire, h, prefs } from "../lib/dom.ts";
import { icon } from "../ui/icons.ts";
import { openModal } from "../ui/modal.ts";
import { assistantSession } from "./instance.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Entry, ToolEntry } from "./session.ts";
import { assistantSettings } from "./settings.ts";
import { openAssistantSettings, PRIVACY_SENTENCE } from "./settings-dialog.ts";

const SUGGESTIONS = [
  "Make a coin sound for the NES",
  "Write a 16-bar Game Boy town theme",
  "Make the bass in this song fuller",
] as const;

export interface AssistantPanel {
  focus: () => void;
  isOpen: () => boolean;
  /** Called when the open document may have changed. */
  refreshContext: () => void;
  toggle: (on?: boolean) => void;
}

const NEAR_BOTTOM = 48;

function thumb(img: ToolEntry["images"][number]): HTMLElement {
  const src = `data:${img.mime};base64,${img.data}`;
  const pic = h("img", {
    alt: img.label,
    height: img.height ?? null,
    src,
    width: img.width ?? null,
  });
  const b = h(
    "button",
    {
      class: "asst-thumb",
      title: `${img.label}: click to enlarge`,
      type: "button",
    },
    pic,
    h("span", {}, img.label)
  );
  b.addEventListener("click", () =>
    openModal(
      h(
        "div",
        { class: "asst-big" },
        h("img", { alt: img.label, src }),
        h("p", {}, img.label)
      ),
      { cls: "wide" }
    )
  );
  return b;
}

const TOOL_ICON = { bad: "warn", ok: "check", run: "step" } as const;

function toolEl(e: ToolEntry): HTMLElement {
  const state = choose<"run" | "bad" | "ok">(
    [
      [e.running, "run"],
      [e.isError, "bad"],
    ],
    "ok"
  );
  const mark = h("span", { class: "tl-mark", "data-state": state });
  mark.innerHTML = icon(TOOL_ICON[state], 12);
  const head = h(
    "div",
    { class: "tl-head" },
    mark,
    h("code", {}, e.name),
    e.target ? h("span", { class: "tl-target" }, e.target) : null,
    e.summary ? h("span", { class: "tl-sum" }, e.summary) : null
  );
  return h(
    "div",
    { class: "am tool", "data-state": state },
    head,
    e.images.length ? h("div", { class: "tl-pics" }, e.images.map(thumb)) : null
  );
}

function entryEl(e: Entry): HTMLElement {
  switch (e.type) {
    case "user":
      return h("div", { class: "am user" }, h("p", {}, e.text));
    case "assistant":
      return h(
        "div",
        { class: `am bot${e.streaming ? " streaming" : ""}` },
        renderMarkdown(e.text)
      );
    case "tool":
      return toolEl(e);
    default:
      return h(
        "div",
        {
          class: `am note ${e.tone}`,
          role: e.tone === "error" ? "alert" : null,
        },
        e.text
      );
  }
}

/** A cheap fingerprint of what an entry shows, so unchanged entries are not rebuilt on every streamed word. */
function stamp(e: Entry): string {
  switch (e.type) {
    case "assistant":
      return `${e.streaming}:${e.text}`;
    case "tool":
      return `${e.running}:${e.isError}:${e.summary}:${e.images.length}`;
    default:
      return e.text;
  }
}

/** Keeps `log` showing the entries: builds what is new, rebuilds what changed, removes what is gone, in order. */
class LogView {
  private readonly made = new Map<number, { el: HTMLElement; stamp: string }>();
  private readonly log: HTMLElement;
  private cursor: Element | null = null;

  constructor(log: HTMLElement) {
    this.log = log;
  }

  private item(e: Entry): HTMLElement {
    const s = stamp(e);
    const old = this.made.get(e.id);
    if (old && old.stamp === s) {
      return old.el;
    }
    const el = entryEl(e);
    if (old) {
      if (this.cursor === old.el) {
        this.cursor = el;
      }
      old.el.replaceWith(el);
    }
    this.made.set(e.id, { el, stamp: s });
    return el;
  }

  render(entries: readonly Entry[]): void {
    const { log } = this;
    const stick =
      log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM;
    this.cursor = log.firstElementChild;
    const alive = new Set<number>();
    for (const e of entries) {
      alive.add(e.id);
      const el = this.item(e);
      if (this.cursor === el) {
        this.cursor = el.nextElementSibling;
      } else {
        log.insertBefore(el, this.cursor);
      }
    }
    for (const [id, item] of this.made) {
      if (!alive.has(id)) {
        item.el.remove();
        this.made.delete(id);
      }
    }
    if (stick) {
      log.scrollTop = log.scrollHeight;
    }
  }
}

function renderSetupCard(
  setup: HTMLElement,
  needs: "key" | "model" | null,
  state: { lookingUp: boolean; problem: string }
): void {
  setup.hidden = needs === null;
  if (needs === null) {
    return;
  }
  if (needs === "model" && !state.problem) {
    setup.replaceChildren(
      h(
        "p",
        {},
        state.lookingUp
          ? "Looking up the models your key can use..."
          : "Almost ready."
      )
    );
    return;
  }
  const add = h(
    "button",
    { class: "btn primary", id: "asstAdd", type: "button" },
    "Add your API key"
  );
  add.addEventListener("click", () => openAssistantSettings());
  setup.replaceChildren(
    h(
      "div",
      { class: "asst-setup-in" },
      h("h3", { class: "pxh" }, "Set up the assistant"),
      h(
        "p",
        {},
        "Ask in plain words for a sound effect, a song or a change to what you have. The assistant builds it with the same documents you edit, renders it and checks the numbers, but it cannot hear it, so you are the ears."
      ),
      h(
        "p",
        {},
        "It works with your own API key from Anthropic or OpenAI. Every change is a normal edit you can undo."
      ),
      state.problem
        ? h("p", { class: "asst-bad", role: "alert" }, state.problem)
        : null,
      add,
      h("p", { class: "asst-fine" }, PRIVACY_SENTENCE)
    )
  );
}

export function createAssistantPanel(host: HTMLElement): AssistantPanel {
  const session = assistantSession;
  const log = h("div", {
    "aria-label": "Conversation",
    "aria-live": "polite",
    class: "asst-log",
    role: "log",
  });
  const setup = h("div", { class: "asst-setup" });
  const chips = h("div", { class: "asst-chips" });
  const ctx = h("div", { class: "asst-ctx" });
  const input = h("textarea", {
    "aria-label": "Message the assistant",
    class: "asst-in",
    placeholder: "Ask for a sound, a song or a change",
    rows: 2,
  });
  const send = h("button", {
    "aria-label": "Send",
    class: "btn primary icon",
    title: "Send (Enter)",
    type: "submit",
  });
  const model = h("small", { class: "asst-model" });
  const newChat = h("button", {
    "aria-label": "New conversation",
    class: "btn icon small ghost",
    title: "New conversation",
    type: "button",
  });
  newChat.innerHTML = icon("plus", 14);
  const gear = h("button", {
    "aria-label": "Assistant settings",
    class: "btn icon small ghost",
    id: "asstGear",
    title: "Assistant settings",
    type: "button",
  });
  gear.innerHTML = icon("gear", 14);
  const closeBtn = h("button", {
    "aria-label": "Close assistant",
    class: "btn icon small ghost",
    title: "Close (Ctrl+J)",
    type: "button",
  });
  closeBtn.innerHTML = icon("close", 14);
  const form = h("form", { class: "asst-form" }, input, send);
  host.append(
    h(
      "header",
      { class: "asst-h" },
      h("span", { class: "asst-title pxh" }, "Assistant"),
      model,
      newChat,
      gear,
      closeBtn
    ),
    log,
    setup,
    chips,
    h("div", { class: "asst-foot" }, ctx, form)
  );

  const logView = new LogView(log);
  const setupState = { lookingUp: false, problem: "" };

  function renderChips(ready: boolean): void {
    const show = ready && session.entries.length === 0;
    chips.hidden = !show;
    if (!show || chips.childElementCount > 0) {
      return;
    }
    for (const text of SUGGESTIONS) {
      const c = h("button", { class: "asst-chip", type: "button" }, text);
      c.addEventListener("click", () => submit(text));
      chips.append(c);
    }
  }

  function renderContext(): void {
    const d = app.currentDoc();
    ctx.replaceChildren(
      "Working on ",
      d ? h("b", {}, `${d.kind}/${d.id}`) : h("b", {}, "no open document")
    );
  }

  /** A remembered key with no model chosen yet: ask the provider which models it can use and pick one. */
  function lookupIfNeeded(needs: "key" | "model" | null): void {
    if (needs === null) {
      setupState.problem = "";
    } else if (
      needs === "model" &&
      !setupState.lookingUp &&
      !setupState.problem
    ) {
      setupState.lookingUp = true;
      session
        .ensureModel()
        .catch((error: unknown) => {
          setupState.problem = explain(error);
        })
        .finally(() => {
          setupState.lookingUp = false;
          render();
        });
    }
  }

  function render(): void {
    const { model: m, provider, setup: needs } = session.status();
    lookupIfNeeded(needs);
    const ready = needs === null;
    host.dataset.state = ready ? "ready" : "setup";
    model.textContent = ready ? m : PROVIDER_LABELS[provider];
    model.title = ready ? `${PROVIDER_LABELS[provider]}: ${m}` : "";
    renderSetupCard(setup, needs, setupState);
    renderChips(ready);
    logView.render(session.entries);
    renderContext();
    input.disabled = !ready;
    const { busy } = session;
    send.innerHTML = icon(busy ? "stop" : "right", 16);
    send.setAttribute("aria-label", busy ? "Stop" : "Send");
    send.title = busy ? "Stop the assistant" : "Send (Enter)";
    send.disabled = !ready;
    send.classList.toggle("danger", busy);
    newChat.disabled = busy;
    form.dataset.busy = String(busy);
  }

  function submit(text: string): void {
    if (session.busy) {
      return;
    }
    input.value = "";
    fire(session.send(text));
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (session.busy) {
      session.stop();
    } else if (input.value.trim()) {
      submit(input.value);
    }
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  newChat.addEventListener("click", () => session.clear());
  gear.addEventListener("click", () => openAssistantSettings());
  closeBtn.addEventListener("click", () => toggle(false));
  session.subscribe(render);
  assistantSettings.subscribe(() => {
    setupState.problem = "";
    render();
  });

  let open = false;
  function toggle(on = !open): void {
    open = on;
    host.hidden = !on;
    document.body.classList.toggle("asst-open", on);
    document.getElementById("bAsst")?.setAttribute("aria-pressed", String(on));
    prefs.set("assistant-open", on);
    if (on) {
      render();
      focus();
    }
  }
  function focus(): void {
    if (
      typeof matchMedia === "function" &&
      matchMedia("(pointer: coarse)").matches
    ) {
      return;
    }
    const target = input.disabled
      ? host.querySelector<HTMLElement>("#asstAdd")
      : input;
    target?.focus();
  }

  host.hidden = true;
  render();
  if (prefs.get("assistant-open", false)) {
    toggle(true);
  }
  return {
    focus,
    isOpen: () => open,
    refreshContext: renderContext,
    toggle,
  };
}
