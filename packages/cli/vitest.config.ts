import { defineProject } from "vitest/config";

export default defineProject({
  test: { environment: "node", name: "bleepkit", testTimeout: 60_000 },
});
