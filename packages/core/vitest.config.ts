import { defineProject } from "vitest/config";

export default defineProject({
  // Pure functions over buffers, no module state to leak between files: files share their workers (`isolate: false`),
  // which saves a worker start per file and keeps the JIT warm for the DSP loops.
  test: {
    environment: "node",
    isolate: false,
    name: "@bleepkit/core",
    testTimeout: 10_000,
  },
});
