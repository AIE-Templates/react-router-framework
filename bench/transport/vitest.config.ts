import { defineConfig } from "vitest/config";

// Only the small unit tests of the harness itself; the benchmarks are run with `pnpm bench:transport`.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ["@repo/source"] },
  test: {
    name: "bench-transport",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
