// Which model to preselect once the key has listed its models. No ids are hard-coded as the only choice: the list
// decides, and these rules only rank what is in it.
import type { ModelInfo, ProviderId } from "../types.ts";

/** Anthropic: the newest model of the opus line (the docs' recommended starting point), else sonnet, else the newest. */
const OPUS = /opus/;
const SONNET = /sonnet/;

function pickAnthropic(models: readonly ModelInfo[]): ModelInfo | undefined {
  const usable = models.filter((m) => m.images !== false);
  const newest = (re: RegExp) =>
    usable
      .filter((m) => re.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))[0];
  return newest(OPUS) ?? newest(SONNET) ?? usable[0] ?? models[0];
}

const FLAGSHIP = /^gpt-(\d+(?:\.\d+)?)$/;
const VARIANT = /(mini|nano|pro|chat|turbo|preview|latest|\d{4}-\d{2}-\d{2})/;

/** OpenAI: the highest plain `gpt-N` or `gpt-N.M` (no mini, nano, pro or dated snapshot), else the newest non-variant. */
function pickOpenAI(models: readonly ModelInfo[]): ModelInfo | undefined {
  const plain = models
    .map((m) => ({ m, v: FLAGSHIP.exec(m.id)?.[1] }))
    .filter((x): x is { m: ModelInfo; v: string } => x.v !== undefined)
    .sort((a, b) => Number(b.v) - Number(a.v));
  return (
    plain[0]?.m ??
    models.find((m) => m.id.startsWith("gpt-") && !VARIANT.test(m.id)) ??
    models[0]
  );
}

export function pickDefaultModel(
  provider: ProviderId,
  models: readonly ModelInfo[]
): ModelInfo | undefined {
  return provider === "anthropic" ? pickAnthropic(models) : pickOpenAI(models);
}
