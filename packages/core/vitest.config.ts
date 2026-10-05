import { defineProject } from "vitest/config";

export default defineProject({
  // Offline song renders are real DSP work: a full genesis song takes seconds, and `test:coverage` runs the whole
  // workspace in parallel with instrumented code on a small CI runner. The default 5 s is a flaky ceiling there.
  test: { environment: "node", name: "@bleepkit/core", testTimeout: 60_000 },
});
