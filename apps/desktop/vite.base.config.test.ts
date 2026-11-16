import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "vite";
import { afterEach, expect, it, vi } from "vitest";

import { entryConfig } from "./vite.base.config";

afterEach(() => vi.unstubAllEnvs());

it.each([false, true])("preserves the intended runtime when watch is %s", async (watch) => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("DESKTOP_WATCH", watch ? "1" : undefined);
  vi.stubEnv("DESKTOP_DEV_SERVER_URL", "http://localhost:5174");
  const directory = mkdtempSync(join(tmpdir(), "desktop vite "));
  const entry = join(directory, "entry.js");
  const fileName = "output.cjs";
  try {
    writeFileSync(
      entry,
      `console.log(JSON.stringify({
  mode: process.env.NODE_ENV,
  devServerUrl: DESKTOP_DEV_SERVER_URL ?? null,
  logLevel: process.env.LOG_LEVEL,
  bootProfile: process.env.DESKTOP_BOOT_PROFILE,
}));`,
    );
    const config = entryConfig({ entry, fileName, format: "cjs" });
    expect(config.build?.watch).toEqual(watch ? {} : null);
    expect(config.build?.minify).toBe(!watch);
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
    expect(JSON.parse(result.stdout)).toEqual({
      mode: watch ? "development" : "production",
      devServerUrl: watch ? "http://localhost:5174" : null,
      logLevel: "debug",
      bootProfile: "1",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
