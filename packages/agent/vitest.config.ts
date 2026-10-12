import { defineProject } from "vitest/config";

export default defineProject({
  // Plain data in, plain data out: files share their workers (`isolate: false`), which saves a worker start per file.
  test: { environment: "node", isolate: false, name: "@bleepkit/agent" },
});
