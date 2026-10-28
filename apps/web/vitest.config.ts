import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to their source, as in vite.config.ts.
const conditions = ["@repo/source", ...defaultServerConditions];

// Kept separate from vite.config.ts so the React Router plugin does not run under Vitest.
export default defineConfig({
  // Tests in the node environment (`@vitest-environment node`) run in the SSR environment, which
  // does not inherit the top-level `resolve.conditions`.
  environments: { ssr: { resolve: { conditions } } },
  resolve: {
    conditions,
    tsconfigPaths: true,
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
