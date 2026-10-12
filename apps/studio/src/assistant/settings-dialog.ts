/* The assistant settings: which provider, the person's own API key, which model, and whether to remember the key on
   this device. Once a key is typed the provider's models endpoint is asked for the list (which also proves the key
   works), and a sensible model is preselected. */
import {
  explain,
  type ModelInfo,
  PROVIDER_IDS,
  PROVIDER_LABELS,
  type ProviderId,
  pickDefaultModel,
} from "@bleepkit/agent";
import { app } from "../app.ts";
import { debounce, fire, h } from "../lib/dom.ts";
import { openModal } from "../ui/modal.ts";
import { assistantSession } from "./instance.ts";
import { assistantSettings as settings } from "./settings.ts";

const CHECK_DELAY = 700;
const MIN_KEY = 8;

export const PRIVACY_SENTENCE =
  "Your key stays in this browser; requests go straight to the provider and are billed to your account.";

const KEY_HINT: Record<ProviderId, string> = {
  anthropic: "Starts with sk-ant-. Make one at console.anthropic.com.",
  openai: "Starts with sk-. Make one at platform.openai.com/api-keys.",
};

const modelLabel = (m: ModelInfo): string =>
  `${m.name}${m.images === false ? " (no images)" : ""}`;

interface Els {
  check: HTMLButtonElement;
  forget: HTMLButtonElement;
  hint: HTMLElement;
  keyInput: HTMLInputElement;
  modelSel: HTMLSelectElement;
  providerSel: HTMLSelectElement;
  remember: HTMLInputElement;
  rememberNote: HTMLElement;
  save: HTMLButtonElement;
  status: HTMLElement;
  toggle: HTMLButtonElement;
}

/** The live state of one open dialog. */
interface Draft {
  control: AbortController | null;
  els: Els;
  models: ModelInfo[];
  provider: ProviderId;
  token: number;
}

function controls(): Els {
  const button = (label: string, cls: string, id: string) =>
    h("button", { class: cls, id, type: "button" }, label);
  return {
    check: button("Check key", "btn small", "asstCheck"),
    forget: button("Forget key", "btn danger", "asstForget"),
    hint: h("small", { class: "asst-hint" }),
    keyInput: h("input", {
      "aria-label": "API key",
      autocapitalize: "off",
      autocomplete: "off",
      id: "asstKey",
      spellcheck: "false",
      type: "password",
    }),
    modelSel: h("select", {
      "aria-label": "Model",
      disabled: true,
      id: "asstModel",
    }),
    providerSel: h(
      "select",
      { "aria-label": "Provider", id: "asstProvider" },
      PROVIDER_IDS.map((id) => h("option", { value: id }, PROVIDER_LABELS[id]))
    ),
    remember: h("input", { id: "asstRemember", type: "checkbox" }),
    rememberNote: h("small", { class: "asst-hint" }),
    save: button("Save", "btn primary", "asstSave"),
    status: h("div", {
      class: "asst-status",
      id: "asstStatus",
      role: "status",
    }),
    toggle: h(
      "button",
      {
        "aria-pressed": "false",
        class: "btn small",
        id: "asstShow",
        type: "button",
      },
      "Show"
    ),
  };
}

function layout(els: Els, cancel: HTMLElement): HTMLElement {
  const row = (...children: (HTMLElement | null)[]) =>
    h("div", { class: "asst-row" }, children);
  return h(
    "form",
    { class: "asst-set", onsubmit: (e: Event) => e.preventDefault() },
    h("h2", { class: "pxh" }, "Assistant settings"),
    h("p", { class: "asst-note" }, PRIVACY_SENTENCE),
    row(h("label", { for: "asstProvider" }, "Provider"), els.providerSel),
    row(
      h("label", { for: "asstKey" }, "API key"),
      h("div", { class: "asst-keyrow" }, els.keyInput, els.toggle),
      els.hint,
      h("div", { class: "asst-keyrow-b" }, els.check, els.status)
    ),
    row(h("label", { for: "asstModel" }, "Model"), els.modelSel),
    row(
      h(
        "label",
        { class: "asst-check", for: "asstRemember" },
        els.remember,
        h("span", {}, "Remember on this device")
      ),
      els.rememberNote
    ),
    h(
      "div",
      { class: "asst-btns" },
      els.forget,
      h("span", { class: "grow" }),
      cancel,
      els.save
    )
  );
}

function say(d: Draft, text: string, tone: "" | "ok" | "bad" = ""): void {
  d.els.status.textContent = text;
  d.els.status.dataset.tone = tone;
}

function sync(d: Draft): void {
  const { els } = d;
  const hasKey = els.keyInput.value.trim().length > 0;
  els.save.disabled = !(hasKey && els.modelSel.value);
  els.check.disabled = !hasKey;
  els.forget.disabled = settings.placeOf(d.provider) === null;
  els.hint.textContent = KEY_HINT[d.provider];
  els.rememberNote.textContent = els.remember.checked
    ? "The key stays in this browser's storage until you press Forget key."
    : "The key is dropped when you close this tab.";
}

function clearModels(d: Draft): void {
  d.models = [];
  d.els.modelSel.replaceChildren();
  d.els.modelSel.disabled = true;
}

function fillModels(d: Draft, list: ModelInfo[]): void {
  const { modelSel } = d.els;
  d.models = list;
  modelSel.replaceChildren(
    ...list.map((m) => h("option", { value: m.id }, modelLabel(m)))
  );
  const saved = settings.choices().models[d.provider];
  const wanted =
    list.find((m) => m.id === saved) ?? pickDefaultModel(d.provider, list);
  if (wanted) {
    modelSel.value = wanted.id;
  }
  modelSel.disabled = list.length === 0;
}

/** Ask the provider for the models this key lists. A newer check replaces an older one still in flight. */
async function check(d: Draft): Promise<void> {
  const key = d.els.keyInput.value.trim();
  d.control?.abort();
  d.token += 1;
  const mine = d.token;
  if (key.length < MIN_KEY) {
    clearModels(d);
    say(
      d,
      key ? "That key looks too short." : "Paste a key to see its models.",
      key ? "bad" : ""
    );
    sync(d);
    return;
  }
  d.control = new AbortController();
  say(d, "Checking the key and listing models...");
  try {
    const list = await assistantSession.loadModels(
      d.provider,
      key,
      d.control.signal
    );
    if (mine !== d.token) {
      return;
    }
    fillModels(d, list);
    const n = list.length;
    say(
      d,
      n
        ? `Key accepted. ${n} model${n === 1 ? "" : "s"} available.`
        : "Key accepted, but it lists no models it can use.",
      n ? "ok" : "bad"
    );
  } catch (error) {
    if (mine !== d.token) {
      return;
    }
    clearModels(d);
    say(d, explain(error), "bad");
  }
  sync(d);
}

function loadProvider(d: Draft): void {
  d.els.keyInput.value = settings.keyOf(d.provider);
  clearModels(d);
  sync(d);
  if (d.els.keyInput.value) {
    fire(check(d));
    return;
  }
  d.control?.abort();
  d.token += 1;
  say(d, "Paste a key to see its models.");
}

function saveDraft(d: Draft, close: () => void): void {
  const { keyInput, modelSel, remember } = d.els;
  const key = keyInput.value.trim();
  if (!(key && modelSel.value)) {
    return;
  }
  // The choices go first: saving the key tells the panel, which sees "a key but no model" and goes to pick a default
  // model for it. The person's pick has to be on record before that can happen.
  settings.saveChoices({
    models: { [d.provider]: modelSel.value },
    provider: d.provider,
    remember: remember.checked,
  });
  settings.saveKey(d.provider, key, remember.checked);
  const picked = d.models.find((m) => m.id === modelSel.value);
  close();
  app.toast(`Assistant ready: ${picked?.name ?? modelSel.value}`);
}

function wire(d: Draft, close: () => void): { stop: () => void } {
  const { els } = d;
  const later = debounce(() => fire(check(d)), CHECK_DELAY);
  els.providerSel.addEventListener("change", () => {
    d.provider = els.providerSel.value as ProviderId;
    later.cancel();
    loadProvider(d);
  });
  els.keyInput.addEventListener("input", () => {
    clearModels(d);
    sync(d);
    say(
      d,
      els.keyInput.value.trim() ? "Waiting for you to finish typing..." : ""
    );
    later();
  });
  els.keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      later.cancel();
      fire(check(d));
    }
  });
  els.check.addEventListener("click", () => {
    later.cancel();
    fire(check(d));
  });
  els.modelSel.addEventListener("change", () => sync(d));
  els.remember.addEventListener("change", () => sync(d));
  els.toggle.addEventListener("click", () => {
    const show = els.keyInput.type === "password";
    els.keyInput.type = show ? "text" : "password";
    els.toggle.textContent = show ? "Hide" : "Show";
    els.toggle.setAttribute("aria-pressed", String(show));
  });
  els.forget.addEventListener("click", () => {
    settings.forgetKey(d.provider);
    els.keyInput.value = "";
    clearModels(d);
    delete assistantSession.models[d.provider];
    say(d, "Key forgotten. It is no longer stored in this browser.");
    sync(d);
  });
  els.save.addEventListener("click", () => saveDraft(d, close));
  return {
    stop: () => {
      later.cancel();
      d.control?.abort();
      d.token += 1;
    },
  };
}

export function openAssistantSettings(): void {
  const choices = settings.choices();
  const d: Draft = {
    control: null,
    els: controls(),
    models: [],
    provider: choices.provider,
    token: 0,
  };
  d.els.providerSel.value = d.provider;
  d.els.remember.checked =
    choices.remember || settings.placeOf(d.provider) === "device";
  const cancel = h("button", { class: "btn", type: "button" }, "Cancel");
  let close: () => void = () => undefined;
  const live = wire(d, () => close());
  cancel.addEventListener("click", () => close());
  close = openModal(layout(d.els, cancel), {
    cls: "asst-modal",
    onClose: live.stop,
  });
  loadProvider(d);
  d.els.keyInput.focus();
}
