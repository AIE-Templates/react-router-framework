import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";

import { entryConfig } from "./vite.base.config";

afterEach(() => vi.unstubAllEnvs());

const options = { entry: "src/main.ts", fileName: "main.cjs", format: "cjs" } as const;

it.each([
  { profile: "dev", watch: true, mode: "development", devServerUrl: "http://localhost:5174" },
  { profile: "test", watch: false, mode: "production", devServerUrl: null },
  { profile: "release", watch: false, mode: "production", devServerUrl: null },
])(
  "builds the $profile profile (watch $watch) into its own directory with the intended runtime",
  async ({ profile, watch, mode, devServerUrl }) => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DESKTOP_BUILD_PROFILE", profile);
    vi.stubEnv("DESKTOP_WATCH", watch ? "1" : undefined);
    vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
    const directory = mkdtempSync(join(tmpdir(), "desktop vite "));
    const entry = join(directory, "entry.js");
    const fileName = "output.cjs";
    try {
      writeFileSync(
        entry,
        `console.log(JSON.stringify({
  profile: DESKTOP_BUILD_PROFILE,
  mode: process.env.NODE_ENV,
  devServerUrl: DESKTOP_DEV_SERVER_URL ?? null,
  logLevel: process.env.LOG_LEVEL,
  bootProfile: process.env.DESKTOP_BOOT_PROFILE,
}));`,
      );
      const config = entryConfig({ entry, fileName, format: "cjs" });
      expect(config.build?.outDir).toBe(`.vite/${profile}`);
      expect(config.build?.watch).toEqual(watch ? {} : null);
      expect(config.build?.minify).toBe(profile !== "dev");
      await build({
        ...config,
        configFile: false,
        logLevel: "silent",
        // Compile one watch iteration without leaving a filesystem watcher running in the suite.
        build: { ...config.build, outDir: join(directory, "dist"), watch: null },
      });
      const result = spawnSync(process.execPath, [join(directory, "dist", fileName)], {
        encoding: "utf8",
        env: { ...process.env, NODE_ENV: "development", LOG_LEVEL: "debug", DESKTOP_BOOT_PROFILE: "1" },
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ profile, mode, devServerUrl, logLevel: "debug", bootProfile: "1" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("builds the test profile when none is named", () => {
  vi.stubEnv("DESKTOP_BUILD_PROFILE", undefined);
  vi.stubEnv("DESKTOP_WATCH", undefined);
  const config = entryConfig(options);
  expect(config.build?.outDir).toBe(".vite/test");
  expect(config.define).toMatchObject({ DESKTOP_BUILD_PROFILE: '"test"' });
});

it("takes an explicit profile over the environment", () => {
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "test");
  vi.stubEnv("DESKTOP_WATCH", undefined);
  expect(entryConfig(options, "release").build?.outDir).toBe(".vite/release");
});

it("rejects an unknown profile, watch mode outside the dev profile and the dev profile outside watch mode", () => {
  vi.stubEnv("DESKTOP_WATCH", undefined);
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "build");
  expect(() => entryConfig(options)).toThrow('Unknown desktop build profile "build"');
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "dev");
  expect(() => entryConfig(options)).toThrow("The dev profile is built in watch mode only");
  vi.stubEnv("DESKTOP_BUILD_PROFILE", "test");
  vi.stubEnv("DESKTOP_WATCH", "1");
  expect(() => entryConfig(options)).toThrow("Watch builds use the dev profile, not test");
});
