/* Where the assistant keeps the person's API key and choices. The key lives in this browser only: in localStorage when
   they chose "Remember on this device", else in sessionStorage (gone when the tab closes). It is never put in the
   project, a URL, a log line or any request but the one to its own provider. Storage can be missing or throw (a
   private window, blocked site data), so every access is guarded and the assistant works without it for the visit. */
import { PROVIDER_IDS, type ProviderId } from "@bleepkit/agent";
import { createEmitter } from "../lib/emitter.ts";

export interface StorageLike {
  getItem: (key: string) => string | null;
  removeItem: (key: string) => void;
  setItem: (key: string, value: string) => void;
}

const KEY_PREFIX = "bleepkit:assistant:key:";
const CHOICES = "bleepkit:assistant:choices";

export interface Choices {
  /** Last chosen model per provider. */
  models: Partial<Record<ProviderId, string>>;
  provider: ProviderId;
  /** "Remember on this device": the key goes to localStorage instead of sessionStorage. */
  remember: boolean;
}

export type KeyPlace = "device" | "session";

export interface AssistantSettings {
  choices: () => Choices;
  /** Forget the stored key of one provider, from both storages. */
  forgetKey: (provider: ProviderId) => void;
  keyOf: (provider: ProviderId) => string;
  /** Where the key of this provider is kept right now, or null when there is none. */
  placeOf: (provider: ProviderId) => KeyPlace | null;
  saveChoices: (patch: Partial<Choices>) => void;
  /** Save the key where `remember` says (and remove it from the other storage). */
  saveKey: (provider: ProviderId, key: string, remember: boolean) => void;
  subscribe: (fn: () => void) => () => void;
}

function guard<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The browser's storages, or null where touching them throws. Looked up on each call: they can come and go. */
const browserStorage = {
  local: (): StorageLike | null => guard(() => globalThis.localStorage, null),
  session: (): StorageLike | null =>
    guard(() => globalThis.sessionStorage, null),
};

export interface Storages {
  local: () => StorageLike | null;
  session: () => StorageLike | null;
}

const isProvider = (v: unknown): v is ProviderId =>
  typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);

function readChoices(store: StorageLike | null): Choices {
  const out: Choices = {
    models: {},
    provider: PROVIDER_IDS[0],
    remember: false,
  };
  const raw = guard(() => store?.getItem(CHOICES) ?? null, null);
  if (!raw) {
    return out;
  }
  const parsed = guard(() => JSON.parse(raw) as Partial<Choices>, {});
  if (isProvider(parsed.provider)) {
    out.provider = parsed.provider;
  }
  out.remember = parsed.remember === true;
  for (const id of PROVIDER_IDS) {
    const m = parsed.models?.[id];
    if (typeof m === "string" && m) {
      out.models[id] = m;
    }
  }
  return out;
}

/** Settings over the given storages (the real ones in the studio, fakes in tests). */
export function createSettings(
  storages: Storages = browserStorage
): AssistantSettings {
  const changes = createEmitter();
  // a key whose storage refused it still works for this visit
  const volatile = new Map<ProviderId, string>();
  // the choices themselves are not secret, and they follow the device: localStorage when it works
  let memory: Choices | null = null;
  const choices = (): Choices => {
    memory ??= readChoices(storages.local() ?? storages.session());
    return memory;
  };
  const { emit } = changes;
  const placeOf = (provider: ProviderId): KeyPlace | null => {
    const name = KEY_PREFIX + provider;
    if (guard(() => storages.local()?.getItem(name), null)) {
      return "device";
    }
    return guard(() => storages.session()?.getItem(name), null) ||
      volatile.has(provider)
      ? "session"
      : null;
  };
  return {
    choices: () => ({ ...choices(), models: { ...choices().models } }),
    forgetKey(provider) {
      const name = KEY_PREFIX + provider;
      guard(() => storages.local()?.removeItem(name), undefined);
      guard(() => storages.session()?.removeItem(name), undefined);
      volatile.delete(provider);
      emit();
    },
    keyOf(provider) {
      const name = KEY_PREFIX + provider;
      return (
        guard(() => storages.local()?.getItem(name), null) ??
        guard(() => storages.session()?.getItem(name), null) ??
        volatile.get(provider) ??
        ""
      );
    },
    placeOf,
    saveChoices(patch) {
      const next: Choices = {
        ...choices(),
        ...patch,
        models: { ...choices().models, ...patch.models },
      };
      memory = next;
      const store = storages.local() ?? storages.session();
      guard(() => store?.setItem(CHOICES, JSON.stringify(next)), undefined);
      emit();
    },
    saveKey(provider, key, remember) {
      const name = KEY_PREFIX + provider;
      const [keep, drop] = remember
        ? [storages.local(), storages.session()]
        : [storages.session(), storages.local()];
      guard(() => drop?.removeItem(name), undefined);
      volatile.set(provider, key);
      guard(() => keep?.setItem(name, key), undefined);
      emit();
    },
    subscribe: changes.subscribe,
  };
}

export const assistantSettings: AssistantSettings = createSettings();
