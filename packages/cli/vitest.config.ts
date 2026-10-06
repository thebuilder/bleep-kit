import { defineProject } from "vitest/config";

export default defineProject({
  // The files of this package share their workers (`isolate: false`): each would otherwise import the CLI and core
  // again. A test that needs a module graph of its own (engine-version.test.ts fakes core's ENGINE_VERSION) resets
  // the modules and puts them back.
  test: {
    environment: "node",
    isolate: false,
    name: "bleepkit",
    testTimeout: 10_000,
  },
});
