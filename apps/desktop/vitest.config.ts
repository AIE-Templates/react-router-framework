import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const conditions = ["@repo/source", ...defaultServerConditions];

export default defineConfig({
  // What vite.base.config.ts compiles into the bundles; source imported by unit tests needs it too.
  define: { DESKTOP_SSR: "true", DESKTOP_BUILD_PROFILE: JSON.stringify("test") },
  environments: { ssr: { resolve: { conditions } } },
  resolve: { conditions, tsconfigPaths: true },
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts", "vite.*.config.test.ts", "e2e/packaged-path.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
