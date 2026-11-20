import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "build.ts");
const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");

interface Invocation {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

describe("production build entry", () => {
  let directory: string;
  let packageManager: string;
  let invocations: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "desktop build "));
    packageManager = join(directory, "package manager.cjs");
    invocations = join(directory, "invocations.jsonl");
    // Run the real entry in a child process. Only the expensive package-manager commands are
    // substituted, so argument forwarding, environment inheritance and exit status are exercised.
    writeFileSync(
      packageManager,
      `const { appendFileSync } = require("node:fs");
appendFileSync(process.env.BUILD_INVOCATIONS, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n");
if (process.argv.includes(process.env.BUILD_FAIL_ARG)) process.exit(7);
`,
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  function run(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    // Windows treats environment keys case-insensitively; pnpm can export NPM_EXECPATH.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => name.toLowerCase() !== "npm_execpath"),
    );
    return spawnSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      env: {
        ...inherited,
        npm_execpath: packageManager,
        BUILD_INVOCATIONS: invocations,
        NODE_ENV: "development",
        DESKTOP_WATCH: "1",
        DESKTOP_DEV_SERVER_URL: "http://localhost:5174",
        DESKTOP_DEV: "1",
        LOG_LEVEL: "debug",
        DESKTOP_BOOT_PROFILE: "1",
        SSR: "false",
        ...extraEnv,
      },
    });
  }

  function readInvocations(): Invocation[] {
    return readFileSync(invocations, "utf8")
      .trim()
      .split("\n")
      .map((line): Invocation => JSON.parse(line));
  }

  it.each([
    { args: [], profile: "test", web: false },
    { args: ["--with-web"], profile: "test", web: true },
    { args: ["test"], profile: "test", web: false },
    { args: ["release", "--with-web"], profile: "release", web: true },
    { args: ["--with-web", "release"], profile: "release", web: true },
  ])("builds the $profile profile with production inputs (arguments $args)", ({ args, profile, web }) => {
    const result = run(args, { DESKTOP_BUILD_PROFILE: "release" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = readInvocations();
    expect(calls.map((call) => ({ args: call.args, cwd: call.cwd }))).toEqual([
      ...(web ? [{ args: ["--filter", "web...", "build"], cwd: repoDir }] : []),
      ...["main", "preload", "utility"].map((entry) => ({
        args: ["exec", "vite", "build", "--config", `vite.${entry}.config.ts`],
        cwd: desktopDir,
      })),
    ]);
    for (const { env } of calls) {
      expect(env).toMatchObject({
        NODE_ENV: "production",
        // The argument decides, never an inherited value.
        DESKTOP_BUILD_PROFILE: profile,
        LOG_LEVEL: "debug",
        DESKTOP_BOOT_PROFILE: "1",
        SSR: "false",
      });
      expect(env).not.toHaveProperty("DESKTOP_WATCH");
      expect(env).not.toHaveProperty("DESKTOP_DEV_SERVER_URL");
      expect(env).not.toHaveProperty("DESKTOP_DEV");
    }
  });

  it.each([
    { args: ["staging"] },
    { args: ["dev"] },
    { args: ["test", "release"] },
    { args: ["--with-web", "--with-web"] },
    { args: ["release", "--workspace"] },
    { args: ["--watch"] },
  ])("rejects the arguments $args before building anything", ({ args }) => {
    const result = run(args);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Usage: build.ts");
    expect(existsSync(invocations)).toBe(false);
  });

  it("normalizes the complete recursive build before any web or desktop command runs", () => {
    expect(run(["--workspace"]).status).toBe(0);
    const [call] = readInvocations();
    expect(call).toMatchObject({
      args: ["-r", "build"],
      cwd: repoDir,
      env: { NODE_ENV: "production", DESKTOP_BUILD_PROFILE: "test" },
    });
    expect(call.env).not.toHaveProperty("DESKTOP_WATCH");
    expect(call.env).not.toHaveProperty("DESKTOP_DEV_SERVER_URL");
    expect(call.env).not.toHaveProperty("DESKTOP_DEV");
  });

  it("stops before desktop bundling when the web build fails", () => {
    expect(run(["--with-web"], { BUILD_FAIL_ARG: "web..." }).status).toBe(7);
    expect(readInvocations()).toHaveLength(1);
  });
});
