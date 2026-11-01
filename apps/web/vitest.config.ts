import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

import { mantineCss } from "./vite-plugins/styles.ts";
import { visualFallbackPlugin } from "./vite-plugins/visual-fallback.ts";

// Workspace packages resolve to their source, as in vite.config.ts.
const conditions = ["@repo/source", ...defaultServerConditions];

// Kept separate from vite.config.ts so the React Router plugin does not run under Vitest.
export default defineConfig({
  plugins: [visualFallbackPlugin()],
  // Tests in the node environment (`@vitest-environment node`) run in the SSR environment, which
  // does not inherit the top-level `resolve.conditions`.
  environments: { ssr: { resolve: { conditions } } },
  resolve: {
    conditions,
    tsconfigPaths: true,
  },
  css: mantineCss,
  test: {
    name: "web",
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}", "vite-plugins/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
