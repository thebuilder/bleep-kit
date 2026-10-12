// What every tool is made of: the definition type, how a definition is built from a typed handler (input checked
// against the schema first), and the small helpers that keep tool output compact and precise.
import { checkInput } from "./schema.ts";
import type { ImageBlock, JsonSchema, ToolSpec } from "./types.ts";

/** What a tool returns to the model, plus the one line the person sees. */
export interface ToolOutput {
  images?: ImageBlock[];
  /** Set when the call failed in a way the model can fix by calling again. */
  isError?: boolean;
  /** One short line for the conversation view: "Rendered song/grid-battle: -15.0 LUFS, no clipping". */
  summary: string;
  /** What the model reads. Capped at `MAX_TOOL_TEXT` characters. */
  text: string;
}

export interface AgentTool {
  run: (input: unknown) => Promise<ToolOutput>;
  spec: ToolSpec;
}

/** Longest tool result text sent to the model; the rest is cut with a note saying so. */
export const MAX_TOOL_TEXT = 12_000;

/** Cut `text` to `max` characters on a line boundary, saying how much was left out. */
function cap(text: string, max = MAX_TOOL_TEXT): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.lastIndexOf("\n", max);
  const keep = text.slice(0, cut > max / 2 ? cut : max);
  return `${keep}\n... (${text.length - keep.length} more characters left out; ask for a smaller part)`;
}

export const fail = (summary: string, text: string): ToolOutput => ({
  isError: true,
  summary,
  text: cap(text),
});

export const done = (summary: string, text: string): ToolOutput => ({
  summary,
  text: cap(text),
});

interface Definition<I> {
  /** Fix up what models commonly get slightly wrong (a JSON object sent as a string) before the schema check. */
  coerce?: (input: Record<string, unknown>) => Record<string, unknown>;
  description: string;
  inputSchema: JsonSchema;
  name: string;
  run: (input: I) => Promise<ToolOutput>;
}

/** Build a tool whose handler only ever sees input that matches its schema. */
export function defineTool<I>(def: Definition<I>): AgentTool {
  return {
    run: async (raw) => {
      const base =
        typeof raw === "object" && raw !== null && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const checked = checkInput(
        def.coerce ? def.coerce(base) : base,
        def.inputSchema
      );
      if (!checked.ok) {
        return fail(
          `${def.name}: bad input`,
          `The input to ${def.name} is not valid, nothing was done:\n${checked.errors.map((e) => `- ${e}`).join("\n")}\nCall it again with these fixed.`
        );
      }
      try {
        return await def.run(checked.value as I);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return fail(`${def.name}: failed`, `${def.name} failed: ${message}`);
      }
    },
    spec: {
      description: def.description,
      inputSchema: def.inputSchema,
      name: def.name,
    },
  };
}

/** A JSON object arriving as a string is parsed; anything else is left for the schema check to judge. */
export function parseJsonField(
  input: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const v = input[field];
  if (typeof v !== "string") {
    return input;
  }
  try {
    return { ...input, [field]: JSON.parse(v) as unknown };
  } catch {
    return input;
  }
}

export const db = (v: number): string => (v <= -119 ? "-inf" : v.toFixed(1));
