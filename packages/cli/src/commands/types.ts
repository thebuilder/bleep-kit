import type { FlagSpec, Parsed } from "../args.ts";
import type { CommandResult, Ctx } from "../output.ts";

export interface CommandSpec {
  /** Longer explanation shown in `--help` under the usage line. */
  description?: string;
  /** At least one runnable example line, shown in `--help`. */
  examples: string[];
  flags: FlagSpec[];
  name: string;
  /** Commands that do not need an existing project (init, studio, help). */
  noProject?: boolean;
  run: (ctx: Ctx, args: Parsed) => Promise<CommandResult> | CommandResult;
  summary: string;
  /** One line, for example `render [ref...] [flags]`. */
  usage: string;
}
