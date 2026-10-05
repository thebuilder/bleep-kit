#!/usr/bin/env node
// Entry point of the `bleepkit` binary: all the work is in cli.ts.
import { main } from "./cli.ts";

const code = await main(process.argv.slice(2));
await new Promise<void>((resolve) => {
  process.stdout.write("", () => {
    process.stderr.write("", () => resolve());
  });
});
process.exit(code);
