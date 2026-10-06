import { analyzeCommand } from "./analyze.ts";
import { describeCommand } from "./describe.ts";
import { exportCommand } from "./export.ts";
import { buildHelpCommand } from "./help.ts";
import { importCommand } from "./import.ts";
import { initCommand } from "./init.ts";
import { listCommand } from "./list.ts";
import { mutateCommand } from "./mutate.ts";
import { newCommand } from "./new.ts";
import { playCommand } from "./play.ts";
import { renderCommand } from "./render.ts";
import { studioCommand } from "./studio.ts";
import type { CommandSpec } from "./types.ts";
import { validateCommand } from "./validate.ts";

const base: CommandSpec[] = [
  initCommand,
  newCommand,
  importCommand,
  mutateCommand,
  validateCommand,
  listCommand,
  renderCommand,
  analyzeCommand,
  describeCommand,
  playCommand,
  exportCommand,
  studioCommand,
];

export const COMMANDS: CommandSpec[] = [...base];
COMMANDS.push(buildHelpCommand(() => COMMANDS));
