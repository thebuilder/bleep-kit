// A small argument parser driven by per-command flag specs. Global flags (--json, --quiet, --project, --seed,
// --help) are part of every spec so they can appear anywhere on the line.
import { CliError, closest } from "./output.ts";

export type FlagType = "string" | "number" | "boolean" | "list";

export interface FlagSpec {
  alias?: string;
  /** Shown in help as the default, for example "48000". */
  default?: string;
  description: string;
  name: string;
  type: FlagType;
  /** Placeholder in help, for example "<id>". */
  valueName?: string;
  /** Allowed values for string flags. */
  values?: readonly string[];
}

export const GLOBAL_FLAGS: FlagSpec[] = [
  {
    description: "print one JSON object on stdout (human text goes to stderr)",
    name: "json",
    type: "boolean",
  },
  {
    alias: "q",
    description: "no progress output",
    name: "quiet",
    type: "boolean",
  },
  {
    description: "project folder (default: found by walking up from the cwd)",
    name: "project",
    type: "string",
    valueName: "<dir>",
  },
  {
    description: "override the project seed for this run",
    name: "seed",
    type: "number",
    valueName: "<n>",
  },
  {
    alias: "h",
    description: "show help for this command",
    name: "help",
    type: "boolean",
  },
];

type FlagValue = string | number | boolean | string[];

export class Parsed {
  readonly positionals: string[];
  private readonly values: Map<string, FlagValue>;

  constructor(positionals: string[], values: Map<string, FlagValue>) {
    this.positionals = positionals;
    this.values = values;
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  str(name: string): string | undefined {
    const v = this.values.get(name);
    return typeof v === "string" ? v : undefined;
  }

  num(name: string): number | undefined {
    const v = this.values.get(name);
    return typeof v === "number" ? v : undefined;
  }

  /** undefined when the flag was not given, so callers can tell "off" from "unset". */
  bool(name: string): boolean | undefined {
    const v = this.values.get(name);
    return typeof v === "boolean" ? v : undefined;
  }

  list(name: string): string[] {
    const v = this.values.get(name);
    return Array.isArray(v) ? v : [];
  }
}

function usageError(message: string, hint?: string): CliError {
  return new CliError("usage", message, hint ? { hint } : {});
}

function findSpec(
  specs: readonly FlagSpec[],
  token: string,
  command: string
): { negated: boolean; spec: FlagSpec } {
  const isLong = token.startsWith("--");
  const bare = isLong ? token.slice(2) : token.slice(1);
  if (!isLong) {
    const byAlias = specs.find((s) => s.alias === bare);
    if (byAlias) {
      return { negated: false, spec: byAlias };
    }
  }
  const exact = specs.find((s) => s.name === bare);
  if (exact) {
    return { negated: false, spec: exact };
  }
  if (bare.startsWith("no-")) {
    const base = specs.find(
      (s) => s.name === bare.slice(3) && s.type === "boolean"
    );
    if (base) {
      return { negated: true, spec: base };
    }
  }
  const names = specs.map((s) => `--${s.name}`);
  const guess = closest(`--${bare}`, names);
  throw usageError(
    `unknown flag ${token} for "${command}"`,
    guess
      ? `did you mean ${guess}? Run "bleepkit ${command} --help" for the flag list.`
      : `Run "bleepkit ${command} --help" for the flag list.`
  );
}

function convert(spec: FlagSpec, raw: string): string | number {
  if (spec.type === "number") {
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) {
      throw usageError(
        `--${spec.name} needs a number (got "${raw}")`,
        `Example: --${spec.name} ${spec.default ?? "1"}`
      );
    }
    return n;
  }
  if (spec.values && !spec.values.includes(raw)) {
    throw usageError(
      `--${spec.name} must be one of ${spec.values.join(", ")} (got "${raw}")`
    );
  }
  return raw;
}

/** Reads the value of a value-taking flag: after `=`, or the next token. Returns the value and tokens consumed. */
function readValue(
  spec: FlagSpec,
  inline: string | null,
  next: string | undefined
): { consumed: number; raw: string } {
  if (inline !== null) {
    return { consumed: 0, raw: inline };
  }
  const looksLikeFlag = next?.startsWith("--") && next.length > 2;
  if (next === undefined || looksLikeFlag) {
    throw usageError(
      `--${spec.name} needs a value`,
      `Example: --${spec.name} ${spec.valueName ?? "<value>"}`
    );
  }
  return { consumed: 1, raw: next };
}

function store(
  values: Map<string, FlagValue>,
  spec: FlagSpec,
  value: string | number
): void {
  if (spec.type !== "list") {
    values.set(spec.name, value);
    return;
  }
  const existing = values.get(spec.name);
  const list = Array.isArray(existing) ? existing : [];
  list.push(String(value));
  values.set(spec.name, list);
}

export function parseArgs(
  argv: readonly string[],
  flags: readonly FlagSpec[],
  command: string
): Parsed {
  const specs = [...flags, ...GLOBAL_FLAGS];
  const positionals: string[] = [];
  const values = new Map<string, FlagValue>();
  let i = 0;
  while (i < argv.length) {
    const token = argv[i] ?? "";
    i += 1;
    if (token === "--") {
      positionals.push(...argv.slice(i));
      break;
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    const inline = eq === -1 ? null : token.slice(eq + 1);
    const { negated, spec } = findSpec(
      specs,
      eq === -1 ? token : token.slice(0, eq),
      command
    );
    if (spec.type === "boolean") {
      values.set(
        spec.name,
        inline === null ? !negated : inline !== "false" && inline !== "0"
      );
      continue;
    }
    const { consumed, raw } = readValue(spec, inline, argv[i]);
    i += consumed;
    store(values, spec, convert(spec, raw));
  }
  return new Parsed(positionals, values);
}
