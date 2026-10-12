import type { Provider, ProviderId, ProviderOptions } from "../types.ts";
import { createAnthropic } from "./anthropic.ts";
import { createOpenAI } from "./openai.ts";

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
};

/** An adapter for a provider, bound to one key. The key is only ever sent to that provider's own API. */
export function createProvider(
  id: ProviderId,
  opts: ProviderOptions
): Provider {
  return id === "anthropic" ? createAnthropic(opts) : createOpenAI(opts);
}
