// What every launcher of the desktop app shares: the Playwright fixtures (e2e/desktop.ts), the
// benchmark (scripts/bench.ts), `pnpm --filter desktop start` and with it the smoke
// (scripts/start.ts), and development (scripts/dev.ts).
// - `launchSpec()` is the one place that says how a target (unpackaged bundles or the packaged test
//   app) of a build profile is started: executable, arguments, Chromium switches, working directory
//   and environment. Callers add only what is theirs (a test's media switch, a user's arguments).
// - Each build profile lives in its own `.vite/<profile>` (scripts/build-profile.ts) and the main
//   process logs the profile it was built with before anything else
//   (`{"buildProfile":"test","msg":"build profile"}`). A launcher that spawns the app itself reads
//   that line from its stdout (`verifyBuildProfile`) and fails when it is not the profile it meant to
//   start, so a stale or mismatched build can never pass as the one under test. Playwright consumes
//   the app's stdout itself; e2e/desktop.ts asks the main process instead (`desktopBuildProfile`).
// - `checkLaunchInputs()` first makes sure the target exists and, unpackaged, that its bundles match
//   the web build (scripts/check-web-build.ts).
// Runs on Node directly (type stripping).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { packagedExecutable } from "../e2e/packaged-path.ts";
import { type BuildProfile, bundleDir } from "./build-profile.ts";
import { buildCommand, checkWebBuild } from "./check-web-build.ts";

export const desktopDir = resolve(import.meta.dirname, "..");

export function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") throw new Error("Electron did not provide an executable path");
  return binary;
}

/**
 * PIDs of the processes of the app under test, this script excluded. POSIX: command lines containing
 * the target's directory followed by a separator (pgrep -f), which covers a macOS bundle's helpers
 * under Contents/Frameworks. Windows: processes whose executable is exactly the target's (every
 * Electron helper there runs the same executable), so nothing else in that directory or in a
 * sibling directory sharing its prefix can match. A failed process listing throws instead of
 * reporting none.
 */
export function appProcesses(executable: string, directory: string): number[] {
  let output: string;
  if (process.platform === "win32") {
    output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $env:E2E_PROCESS_EXE, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8", env: { ...process.env, E2E_PROCESS_EXE: executable } },
    );
  } else {
    try {
      output = execFileSync("pgrep", ["-f", "^" + directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/"], {
        encoding: "utf8",
      });
    } catch (err) {
      // pgrep exits 1 when nothing matches; anything else is a failure to list.
      if (typeof err === "object" && err !== null && "status" in err && err.status === 1) return [];
      throw err;
    }
  }
  return output
    .split(/\r?\n/)
    .map(Number)
    .filter((pid) => pid > 0 && pid !== process.pid);
}

export type LaunchTarget = "unpackaged" | "packaged";

/** How to start one target of one build profile; `env` goes over the caller's environment. */
export interface LaunchSpec {
  target: LaunchTarget;
  profile: BuildProfile;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The directory every process of the app has its executable under, for `appProcesses`. */
  processDir: string;
}

/** The packaged test app electron-builder's `--dir` writes for this machine, only ever in `out/test`. */
export function packagedBinary(directory: string = desktopDir): string {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return packagedExecutable(join(directory, "out", "test"), metadata, process.platform, process.arch);
}

/** A macOS bundle's helpers live under Contents/Frameworks, beside Contents/MacOS: take the bundle. */
function processDirOf(executable: string): string {
  const bundle = executable.lastIndexOf(".app/Contents/MacOS/");
  return process.platform === "darwin" && bundle >= 0 ? executable.slice(0, bundle + 4) : dirname(executable);
}

/**
 * How to start `target` of `profile`: the unpackaged test bundles (`electron .`, package.json `main`
 * is `.vite/test/main.cjs`), the unpackaged dev bundles (`electron .vite/dev`, scripts/dev.ts), or the
 * packaged test app (`out/test` unless `executable` names another packaged test-profile executable).
 * The release profile is not launched by these tools: its fuses stop the drivers and its cookie
 * encryption reaches for the system keychain.
 */
export function launchSpec(
  target: LaunchTarget,
  profile: BuildProfile,
  { executable, directory = desktopDir }: { executable?: string; directory?: string } = {},
): LaunchSpec {
  // Chromium switches every launch of this target and profile gets (platform specifics belong here).
  const switches: string[] = [];
  const env = { NODE_ENV: profile === "dev" ? "development" : "production" };
  if (target === "unpackaged" && (profile === "test" || profile === "dev")) {
    if (executable !== undefined) throw new Error("An unpackaged launch runs this checkout's Electron");
    const command = electronBinary();
    const app = profile === "test" ? "." : join(directory, bundleDir("dev"));
    return {
      target,
      profile,
      command,
      args: [app, ...switches],
      cwd: directory,
      env,
      processDir: processDirOf(command),
    };
  }
  if (target === "packaged" && profile === "test") {
    const command = resolve(executable ?? packagedBinary(directory));
    return { target, profile, command, args: switches, cwd: dirname(command), env, processDir: processDirOf(command) };
  }
  throw new Error(`The ${target} ${profile} build is not a launch target`);
}

/**
 * Throws, saying which command to run, unless what `spec` starts exists and, for the unpackaged test
 * bundles, matches the web build. The dev bundles are checked by scripts/dev.ts, which builds them.
 */
export function checkLaunchInputs(spec: LaunchSpec, directory: string = desktopDir): void {
  if (spec.target === "packaged") {
    if (!existsSync(spec.command)) throw new Error(`${spec.command} is missing: run \`pnpm package:desktop\` first`);
  } else if (spec.profile !== "dev") {
    checkUnpackagedBuild(spec.profile, directory);
  }
}

/**
 * Throws, saying which command to run, unless the profile's unpackaged bundles exist and its
 * utility bundle matches the web client build it will serve.
 */
export function checkUnpackagedBuild(profile: BuildProfile, directory: string = desktopDir): void {
  for (const file of ["main.cjs", "preload.cjs"]) {
    const path = join(bundleDir(profile), file);
    if (!existsSync(join(directory, path))) {
      throw new Error(`${path} is missing: run \`${buildCommand(profile)}\` first`);
    }
  }
  checkWebBuild(directory, profile);
}

/** The build profile a main-process log line reports, if it is the startup line that carries one. */
export function reportedBuildProfile(line: string): string | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const record: unknown = JSON.parse(line);
    return typeof record === "object" &&
      record !== null &&
      "process" in record &&
      record.process === "main" &&
      "buildProfile" in record &&
      typeof record.buildProfile === "string"
      ? record.buildProfile
      : undefined;
  } catch {
    return undefined;
  }
}

/** The error for an app that reports another build profile than the launcher meant to start. */
export function buildProfileMismatch(reported: unknown, expected: BuildProfile): Error {
  return new Error(
    `The launched app reports build profile ${JSON.stringify(reported) ?? "none"}, expected "${expected}"`,
  );
}

/**
 * Resolves once the app writing to `stdout` reports `expected` as its build profile; rejects when it
 * reports another one, when its output ends first or after `timeoutMs`. Reads alongside the stream's
 * other consumers (attach them in the same tick) and detaches when settled, never pausing it.
 */
export function verifyBuildProfile(stdout: Readable, expected: BuildProfile, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const settle = (error?: Error) => {
      clearTimeout(timer);
      stdout.off("data", onData);
      stdout.off("end", onEnd);
      stdout.off("close", onEnd);
      if (error) reject(error);
      else resolvePromise();
    };
    const onData = (chunk: Buffer | string) => {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const reported = reportedBuildProfile(pending.slice(0, newline).trim());
        pending = pending.slice(newline + 1);
        if (reported === undefined) continue;
        settle(reported === expected ? undefined : buildProfileMismatch(reported, expected));
        return;
      }
    };
    const onEnd = () =>
      settle(new Error(`The launched app exited before reporting its build profile (expected ${expected})`));
    const timer = setTimeout(
      () => settle(new Error(`The launched app did not report its build profile within ${timeoutMs} ms`)),
      timeoutMs,
    );
    timer.unref();
    stdout.on("data", onData);
    stdout.once("end", onEnd);
    stdout.once("close", onEnd);
  });
}

/**
 * The manifest Electron needs to start the dev bundles on their directory (`electron .vite/dev`):
 * the entry, and the same name, product name and version as apps/desktop/package.json, so the app
 * name, version and userData directory are those of `electron .`. Returns the file written.
 */
export function writeDevPackageJson(directory: string = desktopDir): string {
  const metadata: unknown = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (typeof metadata !== "object" || metadata === null) throw new Error("apps/desktop/package.json is not an object");
  const pick = (field: string): string => {
    const value: unknown = Reflect.get(metadata, field);
    if (typeof value !== "string") throw new Error(`apps/desktop/package.json has no string ${field}`);
    return value;
  };
  const manifest = { name: pick("name"), productName: pick("productName"), version: pick("version"), main: "main.cjs" };
  const target = join(directory, bundleDir("dev"));
  mkdirSync(target, { recursive: true });
  const file = join(target, "package.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return file;
}
