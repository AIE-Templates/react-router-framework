import { defineConfig } from "vitest/config";

// Each app and package has its own vitest.config.ts; this one runs them all.
export default defineConfig({
  test: {
    projects: ["apps/*", "packages/*"],
  },
});
