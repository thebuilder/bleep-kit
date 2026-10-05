// Output helpers: the error type with its exit code mapping, the per-run context (json mode, quiet mode, streams),
// and small formatters shared by the commands.
import path from "node:path";

export const ERROR_EXIT = {
  bind: 6,
  encode: 5,
  invalid: 1,
  "no-project": 3,
  "not-found": 4,
  usage: 2,
  write: 5,
} as const;

export type ErrorCode = keyof typeof ERROR_EXIT;

export interface ErrorOptions {
  /** The underlying error, kept for debugging (BLEEPKIT_DEBUG=1 prints it). */
  cause?: unknown;
  /** Extra machine readable fields merged into the JSON error object (for example `issues`). */
  details?: Record<string, unknown>;
  /** How to fix it, shown on its own line. */
  hint?: string;
}

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: ErrorOptions = {}) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause }
    );
    this.name = "CliError";
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }

  get exitCode(): number {
    return ERROR_EXIT[this.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.hint ? { hint: this.hint } : {}),
        ...this.details,
      },
      ok: false,
    };
  }
}

export interface Ctx {
  cwd: string;
  /** Print one JSON line on stdout (streaming commands). */
  emit: (value: unknown) => void;
  /** Human text on stderr. */
  err: (text: string) => void;
  isTTY: boolean;
  json: boolean;
  /** Human text on stdout. */
  out: (text: string) => void;
  /** Progress line on stderr, suppressed by --quiet. */
  progress: (text: string) => void;
  projectFlag: string | undefined;
  quiet: boolean;
  seed: number | undefined;
  version: string;
}

export interface CtxOptions {
  cwd?: string;
  isTTY?: boolean;
  json?: boolean;
  projectFlag?: string | undefined;
  quiet?: boolean;
  seed?: number | undefined;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
  version: string;
}

export function createCtx(options: CtxOptions): Ctx {
  const stdout = options.stdout ?? ((t) => process.stdout.write(t));
  const stderr = options.stderr ?? ((t) => process.stderr.write(t));
  const quiet = options.quiet ?? false;
  return {
    cwd: options.cwd ?? process.cwd(),
    emit: (value) => stdout(`${JSON.stringify(value)}\n`),
    err: (text) => stderr(text.endsWith("\n") ? text : `${text}\n`),
    isTTY: options.isTTY ?? Boolean(process.stdout.isTTY),
    json: options.json ?? false,
    out: (text) => stdout(text.endsWith("\n") ? text : `${text}\n`),
    progress: (text) => {
      if (!quiet) {
        stderr(`${text}\n`);
      }
    },
    projectFlag: options.projectFlag,
    quiet,
    seed: options.seed,
    version: options.version,
  };
}

/** What a command returns: the JSON object for --json, the human text otherwise, and an optional exit code. */
export interface CommandResult {
  exit?: number;
  human: string;
  json: Record<string, unknown>;
}

/* ---------- formatters ---------- */

export function fmtDb(db: number | null | undefined): string {
  if (db === null || db === undefined || !Number.isFinite(db)) {
    return "-inf dB";
  }
  return `${db.toFixed(1)} dB`;
}

export function fmtSeconds(seconds: number): string {
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`;
  }
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  return `${m}m${(seconds - m * 60).toFixed(1).padStart(4, "0")}s`;
}

export function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** A path for people: relative to the cwd when that is shorter, always forward slashes. */
export function display(cwd: string, absolute: string): string {
  const rel = path.relative(cwd, absolute);
  const chosen = rel === "" ? "." : rel;
  return (
    chosen.length < absolute.length && !path.isAbsolute(chosen)
      ? chosen
      : absolute
  )
    .split(path.sep)
    .join("/");
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] ?? 0) + 1,
        diag + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** The candidate closest to `word`, when it is close enough to be a plausible typo. */
export function closest(
  word: string,
  candidates: readonly string[]
): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const score =
      c.startsWith(word) || word.startsWith(c) ? 1 : levenshtein(word, c);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best !== null && bestScore <= Math.max(2, Math.floor(word.length / 3))
    ? best
    : null;
}

/** Pads a table of string rows into aligned columns. */
export function table(rows: string[][], gap = 2): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) =>
          i === row.length - 1 ? cell : cell.padEnd((widths[i] ?? 0) + gap)
        )
        .join("")
        .trimEnd()
    )
    .join("\n");
}

/** Indents every line of `text`. */
export function indent(text: string, spaces = 2): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}
