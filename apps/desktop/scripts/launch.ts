// What every launcher of the desktop app shares: the Playwright fixtures (e2e/desktop.ts), the
// benchmark (scripts/bench.ts), `pnpm --filter desktop start` and with it the smoke
// (scripts/start.ts), and development (scripts/dev.ts). Each build profile lives in its own
// `.vite/<profile>` (scripts/build-profile.ts) and the main process logs the profile it was built
// with first thing (`{"buildProfile":"test","msg":"build profile"}`); a launcher reads that line from
// the app's stdout and fails when it is not the profile it meant to start, so a stale or
// mismatched build can never pass as the one under test. Unpackaged launches also check first that
// the bundles exist and match the web build (scripts/check-web-build.ts). Runs on Node directly
// (type stripping).
import { ChildProcess, execFileSync } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

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
        settle(
          reported === expected
            ? undefined
            : new Error(
                `The launched app reports build profile ${JSON.stringify(reported)}, expected ${JSON.stringify(expected)}`,
              ),
        );
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
 * Runs `launch`, which spawns `executable` through a library that consumes its stdout itself (the
 * Playwright Electron driver), and checks the build profile that process reports. The child is
 * picked up through Node's `child_process` diagnostics channel the moment it is spawned, before any
 * output can be lost. On a mismatch, or when no such spawn is seen, `abort` stops what was launched
 * and this throws.
 */
export async function withBuildProfileCheck<T>(
  executable: string,
  expected: BuildProfile,
  launch: () => Promise<T>,
  abort: (launched: T) => Promise<void>,
): Promise<T> {
  let verified: Promise<void> | undefined;
  const onSpawn = (message: unknown) => {
    if (typeof message !== "object" || message === null || !("process" in message)) return;
    const child = message.process;
    if (!(child instanceof ChildProcess)) return;
    // Published from the constructor: the command and stdio exist once spawn() has returned, still
    // before any output is read (that needs a turn of the event loop).
    process.nextTick(() => {
      if (verified || !child.spawnargs?.some((arg) => arg.includes(executable))) return;
      unsubscribe("child_process", onSpawn);
      verified = child.stdout
        ? verifyBuildProfile(child.stdout, expected)
        : Promise.reject(new Error(`${executable} was launched without a stdout pipe`));
      // Awaited below, once `launch` returns; until then a rejection is not unhandled.
      verified.catch(() => {});
    });
  };
  subscribe("child_process", onSpawn);
  let launched: T;
  try {
    launched = await launch();
  } finally {
    unsubscribe("child_process", onSpawn);
  }
  try {
    if (!verified) throw new Error(`Did not see ${executable} being spawned, so its build profile is unknown`);
    await verified;
  } catch (err) {
    await abort(launched).catch(() => {});
    throw err;
  }
  return launched;
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
