import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "port-fetch",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
