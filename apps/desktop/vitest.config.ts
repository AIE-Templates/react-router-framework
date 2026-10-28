import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

const conditions = ["@repo/source", ...defaultServerConditions];

export default defineConfig({
  environments: { ssr: { resolve: { conditions } } },
  resolve: { conditions },
  test: {
    name: "desktop",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
