import { defineProject } from "vitest/config";

export default defineProject({
  // Files share their workers (`isolate: false`): the happy-dom environment is set up once per worker, not per file.
  test: { environment: "happy-dom", isolate: false, name: "@bleepkit/player" },
});
