import { defaultServerConditions } from "vite";
import { defineConfig, type Plugin } from "vitest/config";

const SERVER_BUILD_ID = "virtual:react-router/server-build";

// src/host/app.ts lazily imports React Router's server build, which only the React Router Vite plugin
// provides. Stub it so tests in any environment can import the app; only rendering a page needs it.
const serverBuildStub: Plugin = {
  name: "react-router-server-build-stub",
  resolveId: (id) => (id === SERVER_BUILD_ID ? `\0${SERVER_BUILD_ID}` : undefined),
  load: (id) =>
    id === `\0${SERVER_BUILD_ID}`
      ? 'throw new Error("React Router server build is not available in unit tests");'
      : undefined,
};

import { visualFallbackPlugin } from "./visual-fallback-plugin.ts";

// Workspace packages resolve to their source, as in vite.config.ts.
const conditions = ["@repo/source", ...defaultServerConditions];

// Kept separate from vite.config.ts so the React Router plugin does not run under Vitest.
export default defineConfig({
  plugins: [visualFallbackPlugin(), serverBuildStub],
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
