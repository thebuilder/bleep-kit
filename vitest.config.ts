// `vitest` at the root runs every package once: each package (and the studio) is a project with its own
// vitest.config.ts, which is also what `pnpm test` (Turbo, one run per package) uses.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/*"],
  },
});
