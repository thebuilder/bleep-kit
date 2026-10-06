import { defineProject } from "vitest/config";

export default defineProject({
  // Generators and renders over plain data: files share their workers (`isolate: false`), which saves a worker start
  // per file.
  test: { environment: "node", isolate: false, name: "@bleepkit/sfx" },
});
