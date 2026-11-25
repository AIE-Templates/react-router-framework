import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "electron-cookies",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
