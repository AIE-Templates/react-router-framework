// Shared launch configuration (`launchSpec`), input checks (`checkLaunchInputs`) and build-profile
// verification (`verifyBuildProfile`) for Playwright, smoke, bench and dev launchers.
// Contract: docs/specs/electron-shell.spec.md. Runs on Node directly (type stripping).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  type RmOptions,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { pathToFuseFile } from "@electron/fuses";

import { packagedExecutable } from "../e2e/packaged-path.ts";
import { type BuildProfile, bundleDir } from "./build-profile.ts";
import { buildCommand, checkWebBuild } from "./check-web-build.ts";
import { checkPackagedFuses, describeFuses, type PackagedProfile } from "./fuses.ts";
import { powershellOutput } from "./powershell.ts";

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
    output = powershellOutput(
      "Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $env:E2E_PROCESS_EXE, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { $_.ProcessId }",
      { E2E_PROCESS_EXE: executable },
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

/** Where the app of one target of one build profile is: enough to find its processes. */
export interface LaunchLocation {
  target: LaunchTarget;
  profile: BuildProfile;
  command: string;
  /** The directory every process of the app has its executable under, for `appProcesses`. */
  processDir: string;
}

/** How to start one target of one build profile; `env` goes over the caller's environment. */
export interface LaunchSpec extends LaunchLocation {
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** The packaged app electron-builder's `--dir` writes for this machine, in `out/<profile>` (test by default). */
export function packagedBinary(directory: string = desktopDir, profile: PackagedProfile = "test"): string {
  const metadata = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  return packagedExecutable(join(directory, "out", profile), metadata, process.platform, process.arch);
}

/** A macOS bundle's helpers live under Contents/Frameworks, beside Contents/MacOS: take the bundle. */
function processDirOf(executable: string): string {
  const bundle = executable.lastIndexOf(".app/Contents/MacOS/");
  return process.platform === "darwin" && bundle >= 0 ? executable.slice(0, bundle + 4) : dirname(executable);
}

/**
 * Where `target` of `profile` is: this checkout's Electron for the unpackaged test and dev bundles,
 * the packaged test app (`out/test` unless `executable` names another packaged test-profile
 * executable). The release profile is not launched by these tools: its fuses stop the inspector-based
 * driver, and it contains none of the diagnostics they run. The release launcher and its external verifier resolve their executable with packagedBinary().
 */
export function launchLocation(
  target: LaunchTarget,
  profile: BuildProfile,
  { executable, directory = desktopDir }: { executable?: string; directory?: string } = {},
): LaunchLocation {
  if (target === "unpackaged" && (profile === "test" || profile === "dev")) {
    if (executable !== undefined) throw new Error("An unpackaged launch runs this checkout's Electron");
    const command = electronBinary();
    return { target, profile, command, processDir: processDirOf(command) };
  }
  if (target === "packaged" && profile === "test") {
    const command = resolve(executable ?? packagedBinary(directory));
    return { target, profile, command, processDir: processDirOf(command) };
  }
  throw new Error(`The ${target} ${profile} build is not a launch target`);
}

/**
 * The Chromium switches that keep a test launch away from the system's credential store. The packaged
 * test app encrypts its cookies (the `EnableCookieEncryption` fuse, scripts/fuses.ts), and Chromium
 * keeps that key in the OS store, which on a developer's machine can prompt and on a machine without
 * a desktop session can hang.
 */
export function credentialStoreSwitches(platform: NodeJS.Platform): string[] {
  // macOS: a fixed in-process key instead of the login keychain's "<product> Safe Storage" item.
  if (platform === "darwin") return ["--use-mock-keychain"];
  // Linux: Chromium's built-in static key instead of the Secret Service (gnome-keyring) or KWallet.
  if (platform === "linux") return ["--password-store=basic"];
  // Windows: DPAPI, tied to the user account, never prompts and needs no service: nothing to add.
  return [];
}

/**
 * macOS: `-ApplePersistenceIgnoreState YES`, an argument-domain user default that makes AppKit skip
 * restoring the app's saved window state for this launch. Without it, a launch after the app crashed
 * while opening its windows stops before `ready` in AppKit's modal "reopen windows?" prompt
 * (`promptToIgnorePersistentStateWithCrashHistory:`) until someone answers it (measured: after three
 * crashes during startup, 3 of 3 launches hung there; with it, 2 of 2 were ready in 0.6 s). A test or
 * verification switch, like the mock keychain: the app itself never passes it. Elsewhere: none.
 */
export function windowStateSwitches(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? ["-ApplePersistenceIgnoreState", "YES"] : [];
}

/**
 * What trying to create an unprivileged user namespace gave: `created`, `failed` with the reason, or
 * `unavailable` when there is no `unshare` to try with.
 */
export type UserNamespaceAttempt =
  | { result: "created" }
  | { result: "failed"; reason: string }
  | { result: "unavailable" };

/** How to look at the machine for `linuxSandboxBlocker`; tests pass their own. */
export interface SandboxProbe {
  /** The effective user id of this process (`process.geteuid()`). */
  euid(): number;
  /** A sysctl's value from /proc/sys, trimmed, or undefined when this kernel does not have it. */
  sysctl(name: string): string | undefined;
  /** Owner and mode of a file, or undefined when it does not exist. */
  stat(path: string): { uid: number; mode: number } | undefined;
  /** Tries to create an unprivileged user namespace, the way Chromium's sandbox does. */
  userNamespace(): UserNamespaceAttempt;
}

/** The user namespace attempt of this process, made once: the answer does not change while it runs. */
let userNamespaceAttempt: UserNamespaceAttempt | undefined;

/**
 * `unshare --user --map-root-user true`: a new user namespace with a uid map written, which is what
 * Chromium's namespace sandbox needs, and what a seccomp filter blocking `unshare` or `clone` with
 * namespace flags (Docker's default profile), a kernel switch or an AppArmor restriction refuses.
 */
function tryUserNamespace(): UserNamespaceAttempt {
  try {
    execFileSync("unshare", ["--user", "--map-root-user", "true"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 10_000,
    });
    return { result: "created" };
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
      return { result: "unavailable" };
    }
    const output = typeof err === "object" && err !== null && "stderr" in err ? err.stderr : undefined;
    const stderr = Buffer.isBuffer(output)
      ? output.toString("utf8").trim()
      : typeof output === "string"
        ? output.trim()
        : "";
    return { result: "failed", reason: stderr || (err instanceof Error ? err.message : String(err)) };
  }
}

const machineProbe: SandboxProbe = {
  euid: () => process.geteuid?.() ?? -1,
  sysctl(name) {
    try {
      return readFileSync(join("/proc/sys", ...name.split(".")), "utf8").trim();
    } catch {
      return undefined;
    }
  },
  stat(path) {
    try {
      const { uid, mode } = statSync(path);
      return { uid, mode };
    } catch {
      return undefined;
    }
  },
  userNamespace: () => (userNamespaceAttempt ??= tryUserNamespace()),
};

/**
 * Why Chromium's sandbox cannot start for `executable` on this Linux machine, or undefined when it
 * can, judged from what the machine does rather than only from what it is configured to do.
 * - As root (euid 0) Chromium refuses to start with its sandbox at all ("Running as root without
 *   --no-sandbox is not supported"), whatever else holds.
 * - Otherwise Chromium sandboxes with unprivileged user namespaces and falls back to the setuid helper
 *   `chrome-sandbox` beside the executable; with neither it aborts at startup (`FATAL ...
 *   setuid_sandbox_host.cc ... The SUID sandbox helper binary was found, but is not configured
 *   correctly`). Whether user namespaces work is tried (`unshare --user --map-root-user true`), which
 *   also catches a seccomp filter that blocks them (Docker's default profile) where every sysctl says
 *   they are allowed. Only without `unshare` does the decision fall back to the sysctls alone:
 *   Debian's switch (`kernel.unprivileged_userns_clone=0`) or no namespaces at all
 *   (`user.max_user_namespaces=0`). Ubuntu's AppArmor restriction
 *   (`kernel.apparmor_restrict_unprivileged_userns=1`) is decided per executable, so `unshare`
 *   succeeding under a profile of its own says nothing about Electron, which as an unpacked build has
 *   none: that sysctl counts as a blocker whatever the attempt gave.
 * - The helper works only when owned by root with mode 4755, which an unpacked build's never is
 *   unless someone made it so.
 */
export function linuxSandboxBlocker(executable: string, probe: SandboxProbe = machineProbe): string | undefined {
  if (probe.euid() === 0) {
    return "this runs as root (euid 0), and Chromium does not start its sandbox as root";
  }
  let userns: string | undefined;
  if (probe.sysctl("kernel.apparmor_restrict_unprivileged_userns") === "1") {
    userns = "AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1)";
  } else {
    const attempt = probe.userNamespace();
    if (attempt.result === "failed") {
      userns = `creating an unprivileged user namespace failed (unshare --user --map-root-user: ${attempt.reason})`;
    } else if (attempt.result === "unavailable") {
      if (probe.sysctl("kernel.unprivileged_userns_clone") === "0") {
        userns = "unprivileged user namespaces are disabled (kernel.unprivileged_userns_clone=0)";
      } else if (probe.sysctl("user.max_user_namespaces") === "0") {
        userns = "user namespaces are disabled (user.max_user_namespaces=0)";
      }
    }
  }
  if (userns === undefined) return undefined;
  const helper = join(dirname(executable), "chrome-sandbox");
  const helperStat = probe.stat(helper);
  if (helperStat && helperStat.uid === 0 && (helperStat.mode & 0o7777) === 0o4755) return undefined;
  const found = helperStat
    ? `owned by uid ${helperStat.uid} with mode ${(helperStat.mode & 0o7777).toString(8)}`
    : "missing";
  return `${userns}, and the setuid sandbox helper ${helper} is ${found} (it needs root and mode 4755)`;
}

/** The sandbox notices already printed by this process, so each is printed once. */
const sandboxNotices = new Set<string>();

/**
 * `--no-sandbox` for a test or dev launch on a Linux machine where Chromium's sandbox cannot start
 * (`linuxSandboxBlocker`), with one notice on stderr saying so and why; nothing anywhere else.
 * Playwright's Electron driver adds `--no-sandbox` on Linux by itself unless told otherwise
 * (`chromiumSandbox`, e2e/desktop.ts); the launchers that spawn the app themselves need this. The
 * release build is never given it by these launchers (scripts/verify-release.ts decides for itself).
 */
export function sandboxSwitches(
  platform: NodeJS.Platform,
  executable: string,
  probe: SandboxProbe = machineProbe,
): string[] {
  if (platform !== "linux") return [];
  const blocker = linuxSandboxBlocker(executable, probe);
  if (blocker === undefined) return [];
  if (!sandboxNotices.has(blocker)) {
    sandboxNotices.add(blocker);
    process.stderr.write(`launch: passing --no-sandbox: Chromium's sandbox cannot start here: ${blocker}\n`);
  }
  return ["--no-sandbox"];
}

/** A fresh, empty user data directory for one test launch (or one test's launches), under the system temp directory. */
export function freshUserDataDir(label: string): string {
  return mkdtempSync(join(realpathSync.native(tmpdir()), `desktop-${label}-`));
}

/**
 * Removes a user data directory once its app has exited, retrying for a while: the app's helper
 * processes can still hold files in it for a moment after the main process is gone, which on
 * Windows fails a removal with EBUSY, EPERM or ENOTEMPTY. A directory that still cannot be removed
 * is left behind with a warning on stderr rather than failing the run that used it. Returns whether
 * it is gone.
 */
export function removeUserDataDir(
  directory: string,
  remove: (path: string, options: RmOptions) => void = rmSync,
): boolean {
  try {
    remove(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    return true;
  } catch (err) {
    process.stderr.write(
      `warning: could not remove the user data directory ${directory}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return false;
  }
}

/**
 * How to start `target` of `profile`: the unpackaged test bundles (`electron .`, package.json `main`
 * is `.vite/test/main.cjs`), the unpackaged dev bundles (`electron .vite/dev`, scripts/dev.ts), or the
 * packaged test app (see `launchLocation`). A test launch needs `userDataDir`, the directory it runs
 * on (`--user-data-dir`, which Chromium and with it Electron's `userData` path, the single-instance
 * lock and the utility's compile cache follow); reuse one across the restarts of one test and never
 * share it between runs. `DESKTOP_USER_DATA_SUFFIX` is the dev profile's: only the dev build reads it.
 */
export function launchSpec(
  target: LaunchTarget,
  profile: BuildProfile,
  {
    executable,
    directory = desktopDir,
    userDataDir,
  }: { executable?: string; directory?: string; userDataDir?: string } = {},
): LaunchSpec {
  const location = launchLocation(target, profile, { executable, directory });
  const env: Record<string, string> = { NODE_ENV: profile === "dev" ? "development" : "production" };
  // Chromium switches every launch of this target and profile gets.
  const switches = sandboxSwitches(process.platform, location.command);
  if (profile === "test") {
    if (userDataDir === undefined) throw new Error("A test launch needs a user data directory of its own");
    // An empty name would resolve to the working directory: the checkout itself as the profile.
    if (userDataDir.trim() === "") throw new Error("A test launch's user data directory cannot be empty");
    switches.push(
      `--user-data-dir=${resolve(userDataDir)}`,
      ...credentialStoreSwitches(process.platform),
      ...windowStateSwitches(process.platform),
    );
  } else if (userDataDir !== undefined) {
    throw new Error("Only test launches take a user data directory; dev uses DESKTOP_USER_DATA_SUFFIX");
  }
  if (target === "unpackaged") {
    const app = profile === "test" ? "." : join(directory, bundleDir("dev"));
    return { ...location, args: [app, ...switches], cwd: directory, env };
  }
  return { ...location, args: switches, cwd: dirname(location.command), env };
}

/** Fuse read-backs of this process, per fuse file as it was on disk, so repeated launches read it once. */
const fuseChecks = new Map<string, Promise<void>>();

/**
 * Reads the fuses of a packaged test app and rejects, before anything starts it, unless they are the
 * test profile's (scripts/fuses.ts). Prints the readings once per binary.
 */
export function checkTestPackageFuses(executable: string): Promise<void> {
  const fuseFile = pathToFuseFile(executable);
  const { size, mtimeMs } = statSync(fuseFile);
  const key = `${fuseFile}\0${size}\0${mtimeMs}`;
  let check = fuseChecks.get(key);
  if (check === undefined) {
    check = (async () => {
      const readings = await checkPackagedFuses(executable, "test");
      process.stdout.write(`launch: fuses of ${executable} match the test profile: ${describeFuses(readings)}\n`);
    })();
    fuseChecks.set(key, check);
  }
  return check;
}

/**
 * Rejects, saying which command to run, unless what `spec` starts exists and, for the unpackaged test
 * bundles, matches the web build; for the packaged test app, unless its fuses are the test profile's.
 * The dev bundles are checked by scripts/dev.ts, which builds them.
 */
export async function checkLaunchInputs(spec: LaunchLocation, directory: string = desktopDir): Promise<void> {
  if (spec.target === "packaged") {
    if (!existsSync(spec.command))
      throw new Error(`${spec.command} is missing: run \`pnpm package:desktop:test\` first`);
    await checkTestPackageFuses(spec.command);
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
