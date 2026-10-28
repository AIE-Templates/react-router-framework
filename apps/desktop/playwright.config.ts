import { defineConfig } from "@playwright/test";

import type { Target } from "./e2e/desktop.ts";

// End-to-end tests of the desktop shell through Playwright's Electron driver (`_electron`, no
// browser download). Two targets: the unpackaged build (`pnpm build:desktop`) and the packaged test
// profile (`pnpm package:desktop`); the release profile cannot be driven (inspector fuse off).
export default defineConfig<{ target: Target }>({
  testDir: "e2e",
  testMatch: "*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  // One app at a time: launches are heavy and the timing-sensitive checks stay honest.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  outputDir: "test-results",
  use: { trace: "retain-on-failure" },
  projects: [
    { name: "unpackaged", use: { target: "unpackaged" } },
    { name: "packaged", use: { target: "packaged" } },
  ],
});
