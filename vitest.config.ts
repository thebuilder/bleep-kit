// `vitest` at the root runs every package once: each package (and the studio) is a project with its own
// vitest.config.ts, which is also what `pnpm test` (Turbo, one cached run per package) uses.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      include: ["packages/*/src/**", "apps/*/src/**"],
      provider: "v8",
      // coverage-final.json feeds `fallow health` real per-function coverage
      reporter: ["text-summary", "json"],
    },
    projects: ["packages/*", "apps/*"],
  },
});
