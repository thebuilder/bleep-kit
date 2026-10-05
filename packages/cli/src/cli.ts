// Argument parsing and dispatch. `main` never calls process.exit: it returns the exit code.
import { GLOBAL_FLAGS, parseArgs } from "./args.ts";
import { commandHelp, overview } from "./commands/help.ts";
import { COMMANDS } from "./commands/index.ts";
import type { CommandSpec } from "./commands/types.ts";
import {
  CliError,
  type Ctx,
  type CtxOptions,
  closest,
  createCtx,
} from "./output.ts";

export const VERSION = "0.1.0";

const ERRNO = /^E[A-Z]+$/;

export interface MainOptions {
  cwd?: string;
  isTTY?: boolean;
  stderr?: (text: string) => void;
  stdout?: (text: string) => void;
}

/** Global flags that take a value, so the command word can be found when they come first. */
const VALUE_FLAGS = new Set(
  GLOBAL_FLAGS.filter((f) => f.type !== "boolean").map((f) => `--${f.name}`)
);

function findCommand(argv: readonly string[]): {
  index: number;
  word: string | undefined;
} {
  for (let i = 0; i < argv.length; i += 1) {
    const t = argv[i] ?? "";
    if (t === "--") {
      return { index: -1, word: undefined };
    }
    if (VALUE_FLAGS.has(t)) {
      i += 1;
      continue;
    }
    if (!t.startsWith("-")) {
      return { index: i, word: t };
    }
  }
  return { index: -1, word: undefined };
}

function hasFlag(argv: readonly string[], ...names: string[]): boolean {
  return argv.some((a) => names.includes(a));
}

function overviewJson(text: string) {
  return {
    commands: COMMANDS.map((c) => ({
      name: c.name,
      summary: c.summary,
      usage: c.usage,
    })),
    ok: true,
    text,
    topic: "overview",
  };
}

function commandNotFound(word: string): CliError {
  const guess = closest(
    word,
    COMMANDS.map((c) => c.name)
  );
  return new CliError("usage", `unknown command "${word}"`, {
    hint: guess
      ? `Did you mean "${guess}"? Run \`bleepkit help\` for the list.`
      : "Run `bleepkit help` for the list of commands.",
  });
}

/** `bleepkit`, `bleepkit --help`, `bleepkit --version` and flags without a command. */
function noCommand(argv: readonly string[], ctx: Ctx): number {
  if (hasFlag(argv, "--version", "-v")) {
    ctx.out(`bleepkit ${VERSION}`);
    return 0;
  }
  const text = overview(COMMANDS, VERSION);
  ctx.out(ctx.json ? JSON.stringify(overviewJson(text)) : text);
  return argv.length === 0 || hasFlag(argv, "--help", "-h") ? 0 : 2;
}

async function execute(
  spec: CommandSpec,
  rest: string[],
  ctxOptions: CtxOptions,
  ctx: Ctx
): Promise<number> {
  const args = parseArgs(rest, spec.flags, spec.name);
  if (args.bool("help")) {
    const text = commandHelp(spec);
    ctx.out(
      ctx.json ? JSON.stringify({ ok: true, text, topic: spec.name }) : text
    );
    return 0;
  }
  const runCtx = createCtx({
    ...ctxOptions,
    projectFlag: args.str("project"),
    seed: args.num("seed"),
  });
  const result = await spec.run(runCtx, args);
  runCtx.out(ctx.json ? JSON.stringify(result.json) : result.human);
  return result.exit ?? 0;
}

export async function main(
  argv: readonly string[],
  options: MainOptions = {}
): Promise<number> {
  const ctxOptions: CtxOptions = {
    json: hasFlag(argv, "--json"),
    quiet: hasFlag(argv, "--quiet", "-q"),
    version: VERSION,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    ...(options.isTTY === undefined ? {} : { isTTY: options.isTTY }),
    ...(options.stderr ? { stderr: options.stderr } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
  };
  const ctx = createCtx(ctxOptions);
  try {
    const { index, word } = findCommand(argv);
    if (word === undefined) {
      return noCommand(argv, ctx);
    }
    const spec = COMMANDS.find((c) => c.name === word);
    if (!spec) {
      throw commandNotFound(word);
    }
    const rest = [...argv.slice(0, index), ...argv.slice(index + 1)];
    return await execute(spec, rest, ctxOptions, ctx);
  } catch (error) {
    return reportError(ctx, error);
  }
}

function reportError(ctx: Ctx, error: unknown): number {
  let err: CliError;
  if (error instanceof CliError) {
    err = error;
  } else {
    const e = error as NodeJS.ErrnoException;
    err = new CliError(
      e.code && ERRNO.test(e.code) ? "write" : "invalid",
      `unexpected error: ${e.message}`,
      {
        cause: error,
        hint: "This is probably a bug; re-run with BLEEPKIT_DEBUG=1 for the stack trace.",
      }
    );
  }
  if (process.env.BLEEPKIT_DEBUG) {
    ctx.err(String((err.cause as Error | undefined)?.stack ?? err.stack));
  }
  ctx.err(`error: ${err.message}`);
  if (err.hint) {
    ctx.err(`fix: ${err.hint}`);
  }
  if (ctx.json) {
    ctx.out(JSON.stringify(err.toJSON()));
  }
  return err.exitCode;
}
