import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const conditions = ["@repo/source", ...defaultServerConditions];

export default defineConfig({
  environments: { ssr: { resolve: { conditions } } },
  resolve: { conditions, tsconfigPaths: true },
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts", "e2e/packaged-path.test.ts"],
    globalSetup: ["./vitest.global-setup.ts"],
  },
});
