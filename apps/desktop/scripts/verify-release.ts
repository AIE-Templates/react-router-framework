// `pnpm verify:release`: checks the packaged release app in out/release from the outside, the way it
// will be shipped. This is the one and only place that launches a release package: the launchers of
// scripts/launch.ts refuse to (the release build has no diagnostics to run and its fuses stop the
// inspector-based test driver), so every release launch here is started, watched and ended by this
// script itself.
//
//   node scripts/verify-release.ts [--no-build] [--distribution] [--allow-no-sandbox]
//
// By default it first builds the release and test bundles (as scripts/verify-build.ts does; the web
// build must exist) and packages the release app (`package:release`), so it checks what the source
// says; it must then run through pnpm. `--no-build` checks the out/release on disk as it is.
// Five checks, each ending in one result line, `pass`, `fail` or `skipped` with its reason; the exit
// status is 1 when any check failed. Skipped checks are never counted as passed.
// 1. Fuses: the six fuses read back from the packaged binary are the release column of
//    scripts/fuses.ts.
// 2. Package contents, from the final app.asar itself (scripts/asar.ts): exactly the release
//    manifest and bundles (no other profile's bundles, nothing stray, nothing unpacked), entry
//    `.vite/release/main.cjs`, every file matching the integrity the archive records (and on macOS
//    the header the integrity Info.plist records); the bundles are byte for byte those whose module
//    lists and text scripts/verify-build.ts checks here (with its test-profile control), and their
//    text is checked again as shipped; the client assets the shipped utility references are in the
//    package's resources.
// 3. Remote debugging refused: the release app started with `--remote-debugging-port=<free port>`
//    and with `--remote-debugging-pipe` (given pipes on fds 3 and 4) must each exit with the refusal's
//    own code and log line (src/startup-signals.ts) and nothing else; the port must never accept a
//    connection while it runs, nor the pipe answer a command. The packaged test app started the same
//    way must open the port, or the check fails: that is what shows a launch like this would have
//    been heard. Needs out/test (`pnpm package:desktop`).
// 4. Startup smoke: the release app on a fresh `--user-data-dir`, kept off the system credential
//    store (`--use-mock-keychain` on macOS, `--password-store=basic` on Linux), must report the
//    release build profile and its main window ready (MAIN_WINDOW_READY_MESSAGE) within 30 s, then,
//    asked to quit from outside (SIGTERM on macOS and Linux, `taskkill` without /F on Windows), exit
//    0 with every process it started gone. It must have written its data into that directory and
//    left the installed app's userData directory as it was (absent stays absent).
// 5. Signing: by intended use (scripts/release-verdicts.ts, `judgeSigning`). A local unsigned package
//    is skipped; `--distribution` declares the package is for distribution, where a missing or
//    invalid signature fails (macOS: codesign deep strict verify, stapled notarization, Gatekeeper;
//    Windows: Authenticode). Nothing here needs a signing key. Linux: nothing applies.
// Linux hosts where Chromium's sandbox cannot start (scripts/launch.ts, `linuxSandboxBlocker`) skip
// checks 3 and 4, saying what the host needs, unless `--allow-no-sandbox` lets them run with
// `--no-sandbox`, which their result lines then state. Checks 1, 2 and 5 run anyway.
// On macOS every launch carries `--use-mock-keychain` (measured: the release package then encrypts
// its cookies with Chromium's mock key, and the login keychain is neither read for nor given a
// "<product> Safe Storage" item), and a hard deadline that kills the launch's whole process tree. A
// launch that does not get ready in time is killed and fails, never retried: on a machine where the
// mock keychain had no effect, a keychain dialog could be waiting on screen.
// Runs on Node directly (type stripping).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";

import { MAIN_WINDOW_READY_MESSAGE } from "../src/startup-signals.ts";
import { asarFile, asarHeaderHash, readAsar, sha256 } from "./asar.ts";
import { bundleDir, type Bundle, perBundle } from "./build-profile.ts";
import { checkBundleTexts } from "./bundle-markers.ts";
import { referencedClientAssets } from "./check-web-build.ts";
import { checkPackagedFuses, describeFuses } from "./fuses.ts";
import {
  checkLaunchInputs,
  credentialStoreSwitches,
  desktopDir,
  freshUserDataDir,
  launchSpec,
  linuxSandboxBlocker,
  packagedBinary,
  removeUserDataDir,
} from "./launch.ts";
import {
  ALLOW_NO_SANDBOX_FLAG,
  checkAsarContents,
  checkBundleLink,
  type CheckResult,
  type CheckStatus,
  describeExit,
  describeProcesses,
  DISTRIBUTION_FLAG,
  judgeRefusal,
  judgeSigning,
  type LaunchGate,
  launchGate,
  type LaunchOutcome,
  launchProcesses,
  leftoverProcesses,
  mainLogLines,
  type Manifest,
  missingKinds,
  type ProcessInfo,
  type ProcessLocation,
  type SignatureFacts,
  summarize,
} from "./release-verdicts.ts";
import { buildCheckedBundles, checkBuiltBundles } from "./verify-build.ts";

const USAGE = `Usage: verify-release.ts [--no-build] [${DISTRIBUTION_FLAG}] [${ALLOW_NO_SANDBOX_FLAG}]`;
/** How long a normal release launch may take to report its main window ready. */
const READY_TIMEOUT_MS = 30_000;
/** How long a refused launch may take to exit. */
const REFUSAL_TIMEOUT_MS = 15_000;
/** How long the app may take to quit once asked, and its helpers to be gone after it. */
const QUIT_TIMEOUT_MS = 15_000;
const LEFTOVER_GRACE_MS = 5_000;
const isWindows = process.platform === "win32";

function say(line: string): void {
  process.stdout.write(`verify:release: ${line}\n`);
}

// ---- the package ----------------------------------------------------------------------------------

interface Package {
  executable: string;
  location: ProcessLocation;
  resources: string;
  /** The .app bundle on macOS, for codesign. */
  bundle?: string;
  manifest: Manifest;
}

function readManifest(): Manifest {
  const metadata: unknown = JSON.parse(readFileSync(join(desktopDir, "package.json"), "utf8"));
  const field = (name: string): string => {
    const value: unknown = typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, name) : undefined;
    if (typeof value !== "string") throw new Error(`apps/desktop/package.json has no string ${name}`);
    return value;
  };
  return { name: field("name"), productName: field("productName"), version: field("version") };
}

function locatePackage(): Package {
  const executable = packagedBinary(desktopDir, "release");
  const manifest = readManifest();
  if (process.platform === "darwin") {
    const bundle = executable.slice(0, executable.lastIndexOf(".app/") + 4);
    return {
      executable,
      location: { command: executable, processDir: bundle },
      resources: join(bundle, "Contents", "Resources"),
      bundle,
      manifest,
    };
  }
  const directory = dirname(executable);
  return {
    executable,
    location: { command: executable, processDir: directory },
    resources: join(directory, "resources"),
    manifest,
  };
}

/** The installed app's userData directory: Electron's appData plus the product name. */
function realUserDataDir(productName: string): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", productName);
  if (isWindows) return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), productName);
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), productName);
}

/** Every entry under `directory` with its size and modification time, or "absent". */
function fingerprint(directory: string): string {
  if (!existsSync(directory)) return "absent";
  const lines: string[] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path);
    lines.push(`${relative(directory, path) || "."} ${stat.isDirectory() ? "dir" : stat.size} ${stat.mtimeMs}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).toSorted()) walk(join(path, name));
  };
  walk(directory);
  return lines.join("\n");
}

// ---- processes ------------------------------------------------------------------------------------

/** Every process on the machine, with what `launchProcesses` needs. Throws when the listing fails. */
function listProcesses(): ProcessInfo[] {
  if (isWindows) {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const rows: unknown = JSON.parse(output);
    return (Array.isArray(rows) ? rows : [rows]).flatMap((row: unknown) => {
      if (typeof row !== "object" || row === null) return [];
      const get = (name: string): unknown => Reflect.get(row, name);
      const pid = Number(get("ProcessId"));
      const executable = get("ExecutablePath");
      const command = get("CommandLine");
      return [
        {
          pid,
          ppid: Number(get("ParentProcessId")),
          command: typeof command === "string" ? command : "",
          executable: typeof executable === "string" ? executable : undefined,
        },
      ];
    });
  }
  const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,args="], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), command: match[4] }] : [];
  });
}

function kill(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {}
}

/** Kills a launch's whole tree: its process group or Windows process tree, and anything else listed. */
function killTree(rootPid: number, others: readonly ProcessInfo[] = []): void {
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    kill(-rootPid);
  }
  for (const process of others) kill(process.pid);
}

// ---- launches -------------------------------------------------------------------------------------

/** The caller's environment without what would change what an Electron app does. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || /^(DESKTOP_|ELECTRON_|WEB_SHELL|NODE_OPTIONS$)/.test(name)) continue;
    env[name] = value;
  }
  return env;
}

interface Running {
  pid: number;
  stdout(): string;
  stderr(): string;
  /** Resolves when the main process exited (or was killed at the deadline). */
  exited: Promise<LaunchOutcome>;
  isRunning(): boolean;
  /** Extra stdio streams (fd 3 and up). */
  extra: (Readable | Writable | null)[];
  /** Kills the launch's tree and marks it timed out. */
  expire(): void;
}

/**
 * Starts `command` as the leader of its own process group (POSIX), with a hard deadline that kills
 * the whole tree. Each line of stdout is passed to `onLine`.
 */
function startApp(
  command: string,
  args: string[],
  {
    deadlineMs,
    extraFds = 0,
    env = cleanEnv(),
    onLine,
  }: { deadlineMs: number; extraFds?: number; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
): Running {
  const child = spawn(command, args, {
    cwd: dirname(command),
    env,
    detached: !isWindows,
    stdio: ["ignore", "pipe", "pipe", ...Array.from({ length: extraFds }, () => "pipe" as const)],
  });
  const { pid, stdout: out, stderr: err } = child;
  if (pid === undefined || out === null || err === null) throw new Error(`could not start ${command}`);
  let stdout = "";
  let stderr = "";
  let pending = "";
  out.setEncoding("utf8");
  out.on("data", (chunk: string) => {
    stdout += chunk;
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      onLine?.(pending.slice(0, newline).trim());
      pending = pending.slice(newline + 1);
    }
  });
  err.setEncoding("utf8");
  err.on("data", (chunk: string) => (stderr += chunk));
  let timedOut = false;
  let running = true;
  const expire = () => {
    if (!running) return;
    timedOut = true;
    killTree(pid);
  };
  const timer = setTimeout(expire, deadlineMs);
  const exited = new Promise<LaunchOutcome>((resolveExit) => {
    child.once("error", (error) => {
      running = false;
      clearTimeout(timer);
      stderr += `${error.message}\n`;
      resolveExit({ code: null, signal: null, timedOut, stdout });
    });
    child.once("exit", (code, signal) => {
      running = false;
      clearTimeout(timer);
      // The pipes may still hold the last output.
      setImmediate(() => resolveExit({ code, signal, timedOut, stdout }));
    });
  });
  for (const stream of child.stdio.slice(3)) stream?.on("error", () => {});
  return {
    pid,
    stdout: () => stdout,
    stderr: () => stderr,
    exited,
    isRunning: () => running,
    extra: child.stdio.slice(3).map((stream) => stream ?? null),
    expire,
  };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")),
      );
    });
  });
}

function accepts(port: number, host: string): Promise<boolean> {
  return new Promise((resolveConnect) => {
    const socket = connect({ port, host });
    const done = (result: boolean) => {
      socket.destroy();
      resolveConnect(result);
    };
    socket.setTimeout(250, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

const listening = async (port: number) => (await accepts(port, "127.0.0.1")) || (await accepts(port, "::1"));

/** The Chromium switches of every release launch: its own user data directory, off the credential store. */
function releaseSwitches(userDataDir: string, gate: LaunchGate): string[] {
  return [`--user-data-dir=${userDataDir}`, ...credentialStoreSwitches(process.platform), ...gate.switches];
}

// ---- checks ---------------------------------------------------------------------------------------

function report(id: number, name: string, status: CheckStatus, reason: string): CheckResult {
  say(`${id} ${name}: ${status}: ${reason}`);
  return { id, name, status, reason };
}

async function checkFuses(pkg: Package): Promise<CheckResult> {
  const name = "fuses";
  try {
    const readings = await checkPackagedFuses(pkg.executable, "release");
    return report(1, name, "pass", `the release column of scripts/fuses.ts: ${describeFuses(readings)}`);
  } catch (err) {
    return report(1, name, "fail", err instanceof Error ? err.message : String(err));
  }
}

function checkContents(pkg: Package): CheckResult {
  const name = "package contents";
  const problems: string[] = [];
  const findings: string[] = [];
  const archivePath = join(pkg.resources, "app.asar");
  const archive = readFileSync(archivePath);
  const asar = readAsar(archive);
  const files = (path: string) => asarFile(archive, asar, path);
  const has = (path: string) =>
    asar.entries.some((entry) => entry.path === path && entry.kind === "file" && !entry.unpacked);

  let manifest: unknown;
  try {
    manifest = has("package.json") ? JSON.parse(files("package.json").toString("utf8")) : undefined;
  } catch (err) {
    problems.push(`app.asar's package.json is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const contents = checkAsarContents(asar.entries, manifest, pkg.manifest, (path) => sha256(files(path)));
  problems.push(...contents.problems);
  findings.push(...contents.findings);
  for (const extra of ["app", "app.asar.unpacked"]) {
    if (existsSync(join(pkg.resources, extra))) problems.push(`the package has ${extra} beside app.asar`);
  }

  // Electron validates the archive's header against what the app records (the asar integrity fuse).
  if (process.platform === "darwin") {
    const plist = join(pkg.bundle!, "Contents", "Info.plist");
    const recorded = spawnSync(
      "plutil",
      ["-extract", "ElectronAsarIntegrity.Resources/app\\.asar.hash", "raw", "-o", "-", plist],
      {
        encoding: "utf8",
      },
    );
    const hash = asarHeaderHash(asar);
    if (recorded.status !== 0) problems.push(`Info.plist records no asar integrity: ${recorded.stderr.trim()}`);
    else if (recorded.stdout.trim() !== hash)
      problems.push(`Info.plist's asar integrity is not app.asar's header (${hash.slice(0, 12)}…)`);
    else findings.push("Info.plist's asar integrity is app.asar's header");
  }

  const bytes = (bundle: Bundle) => {
    const path = `${bundleDir("release")}/${bundle}`;
    return has(path) ? files(path) : Buffer.alloc(0);
  };
  const shipped = perBundle((bundle) => sha256(bytes(bundle)));
  const code = perBundle((bundle) => bytes(bundle).toString("utf8"));
  if (problems.length === 0) {
    try {
      const built = checkBuiltBundles();
      problems.push(...built.problems.map((problem) => `verify:build: ${problem}`));
      const link = checkBundleLink(shipped, built.release);
      problems.push(...link.problems);
      findings.push(...link.findings);
      if (built.problems.length === 0) {
        findings.push("verify:build passes on them (module lists and text, with the test bundles as control)");
      }
    } catch (err) {
      problems.push(
        `verify:build cannot check the release bundles: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The shipped text itself, whatever the link says.
    const text = checkBundleTexts("release", code);
    problems.push(...text.problems.map((problem) => `as shipped: ${problem}`));
    if (text.problems.length === 0) findings.push("their shipped text has none of the diagnostic or debug markers");

    const assets = join(pkg.resources, "client", "assets");
    const referenced = referencedClientAssets(code["utility.mjs"]);
    const missing = referenced.filter((file) => !existsSync(join(assets, file)));
    if (referenced.length === 0) problems.push("the shipped utility references no hashed client assets");
    else if (missing.length > 0)
      problems.push(`resources/client lacks assets the shipped utility references: ${missing.join(", ")}`);
    else findings.push(`resources/client has all ${referenced.length} assets the shipped utility references`);
  }
  return problems.length > 0
    ? report(2, name, "fail", problems.join("; "))
    : report(2, name, "pass", findings.join("; "));
}

/** One release launch with a remote debugging switch, watched until it exits. */
async function refusedLaunch(
  pkg: Package,
  gate: LaunchGate,
  remoteSwitch: "remote-debugging-port" | "remote-debugging-pipe",
): Promise<{ ok: boolean; reason: string }> {
  const userDataDir = freshUserDataDir("verify-release");
  try {
    const port = remoteSwitch === "remote-debugging-port" ? await freePort() : undefined;
    const app = startApp(
      pkg.executable,
      [
        ...releaseSwitches(userDataDir, gate),
        port === undefined ? "--remote-debugging-pipe" : `--remote-debugging-port=${port}`,
      ],
      { deadlineMs: REFUSAL_TIMEOUT_MS, extraFds: port === undefined ? 2 : 0 },
    );
    let listened = false;
    let answered = false;
    if (port === undefined) {
      // Chromium reads commands from fd 3 and answers on fd 4: ask it something it would answer.
      const [commands, replies] = app.extra;
      replies?.on("data", () => (answered = true));
      if (commands && "end" in commands) commands.end(`${JSON.stringify({ id: 1, method: "Browser.getVersion" })}\0`);
    } else {
      // Polled for the whole life of the process, and once more after it.
      while (app.isRunning() && !listened) listened = await listening(port);
      if (listened) app.expire();
    }
    const outcome = await app.exited;
    if (port !== undefined && !listened) listened = await listening(port);
    killTree(app.pid);
    const verdict = judgeRefusal(outcome, remoteSwitch, { listened, answered });
    const stderr = app.stderr().trim();
    return verdict.ok || stderr === ""
      ? verdict
      : { ...verdict, reason: `${verdict.reason} (stderr: ${stderr.slice(0, 300)})` };
  } finally {
    removeUserDataDir(userDataDir);
  }
}

/** The positive control: the packaged test app, started the normal test way plus a debugging port, opens it. */
async function testPackageListens(): Promise<{ ok: boolean; reason: string }> {
  const userDataDir = freshUserDataDir("verify-release-control");
  try {
    let spec: ReturnType<typeof launchSpec>;
    try {
      spec = launchSpec("packaged", "test", { userDataDir });
      await checkLaunchInputs(spec);
    } catch (err) {
      return {
        ok: false,
        reason: `the test package cannot be launched: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const port = await freePort();
    const app = startApp(spec.command, [...spec.args, `--remote-debugging-port=${port}`], {
      deadlineMs: READY_TIMEOUT_MS,
      env: { ...cleanEnv(), ...spec.env },
    });
    let opened = false;
    while (app.isRunning() && !opened) {
      opened = await listening(port);
      if (!opened) await new Promise((r) => setTimeout(r, 50));
    }
    let browser = "";
    if (opened) {
      try {
        const version: unknown = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const value = typeof version === "object" && version !== null ? Reflect.get(version, "Browser") : undefined;
        browser = typeof value === "string" ? value : "";
      } catch {}
    }
    if (app.isRunning()) {
      if (isWindows) killTree(app.pid);
      else kill(app.pid, "SIGTERM");
      const quit = setTimeout(() => killTree(app.pid), QUIT_TIMEOUT_MS);
      await app.exited;
      clearTimeout(quit);
    }
    const outcome = await app.exited;
    killTree(app.pid);
    if (!opened) {
      return {
        ok: false,
        reason: `the test package started the same way never opened its port (it ${describeExit(outcome)})`,
      };
    }
    return {
      ok: true,
      reason: `the test package started the same way opened its port${browser ? ` (${browser})` : ""}`,
    };
  } finally {
    removeUserDataDir(userDataDir);
  }
}

async function checkRefusal(pkg: Package, gate: LaunchGate): Promise<CheckResult> {
  const name = "remote debugging refused";
  if (!gate.run) return report(3, name, "skipped", gate.note!);
  const failures: string[] = [];
  const passes: string[] = [];
  for (const remoteSwitch of ["remote-debugging-port", "remote-debugging-pipe"] as const) {
    const verdict = await refusedLaunch(pkg, gate, remoteSwitch);
    (verdict.ok ? passes : failures).push(`--${remoteSwitch}: ${verdict.reason}`);
  }
  passes.push("the port never accepted a connection, the pipe never answered");
  const control = await testPackageListens();
  if (!control.ok) failures.push(`positive control failed, so the refusal proves nothing: ${control.reason}`);
  else passes.push(`positive control: ${control.reason}`);
  const note = gate.note ? `${gate.note}. ` : "";
  return failures.length > 0
    ? report(3, name, "fail", note + failures.join("; "))
    : report(3, name, "pass", note + passes.join("; "));
}

async function checkStartup(pkg: Package, gate: LaunchGate): Promise<CheckResult> {
  const name = "startup smoke";
  if (!gate.run) return report(4, name, "skipped", gate.note!);
  const note = gate.note ? `${gate.note}. ` : "";
  const fail = (reason: string) => report(4, name, "fail", note + reason);
  const realUserData = realUserDataDir(pkg.manifest.productName);
  const before = fingerprint(realUserData);
  const preexisting = new Set(listProcesses().map((process) => process.pid));
  const userDataDir = freshUserDataDir("verify-release");
  try {
    const started = performance.now();
    let profile: string | undefined;
    // Assigned at once: a promise runs its executor synchronously.
    let settle: ((ready: boolean) => void) | undefined;
    const ready = new Promise<boolean>((resolveReady) => {
      settle = resolveReady;
    });
    const settleReady = (value: boolean) => settle?.(value);
    const app = startApp(pkg.executable, releaseSwitches(userDataDir, gate), {
      // The deadline of the whole launch; reaching ready has its own, below.
      deadlineMs: READY_TIMEOUT_MS + QUIT_TIMEOUT_MS + 5_000,
      onLine(line) {
        const [record] = mainLogLines(line);
        if (record === undefined) return;
        if (profile === undefined && typeof record.buildProfile === "string") {
          profile = record.buildProfile;
          if (profile !== "release") settleReady(false);
        }
        if (record.msg === MAIN_WINDOW_READY_MESSAGE) settleReady(true);
      },
    });
    void app.exited.then(() => settleReady(false));
    const readyTimer = setTimeout(() => settleReady(false), READY_TIMEOUT_MS);
    const isReady = await ready;
    clearTimeout(readyTimer);
    const readyMs = Math.round(performance.now() - started);
    if (!isReady) {
      // Whether it ended by itself, before anything here killed it.
      const endedByItself = !app.isRunning();
      const launched = launchProcesses(listProcesses(), app.pid, preexisting, pkg.location, process.platform);
      killTree(app.pid, launched);
      const outcome = await app.exited;
      if (profile !== undefined && profile !== "release")
        return fail(`the app reports build profile ${profile}, not release`);
      if (endedByItself) {
        return fail(
          `the app ${describeExit(outcome)} ${profile === undefined ? "without reporting its build profile" : "before its main window was ready"}`,
        );
      }
      const keychain =
        process.platform === "darwin" ? "; a keychain dialog may be waiting on screen (not retried)" : "";
      return fail(
        `${profile === undefined ? "the app did not report its build profile" : "its main window was not ready"} ` +
          `within ${READY_TIMEOUT_MS / 1000} s; killed with all its processes${keychain}`,
      );
    }

    const launched = launchProcesses(listProcesses(), app.pid, preexisting, pkg.location, process.platform);
    const seen = describeProcesses(launched, app.pid);
    const missing = missingKinds(launched, app.pid);
    // Ask it to quit the way a user's system would.
    const quitStarted = performance.now();
    if (isWindows) {
      const asked = spawnSync("taskkill", ["/PID", String(app.pid)], { encoding: "utf8" });
      if (asked.status !== 0) say(`4 ${name}: taskkill: ${(asked.stderr || asked.stdout).trim()}`);
    } else {
      kill(app.pid, "SIGTERM");
    }
    const quitTimer = setTimeout(() => app.expire(), QUIT_TIMEOUT_MS);
    const outcome = await app.exited;
    clearTimeout(quitTimer);
    const quitMs = Math.round(performance.now() - quitStarted);
    // Its helpers end right after it; give them a moment.
    let leftovers = leftoverProcesses(listProcesses(), launched, app.pid, preexisting, pkg.location, process.platform);
    const until = Date.now() + LEFTOVER_GRACE_MS;
    while (leftovers.length > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 100));
      leftovers = leftoverProcesses(listProcesses(), launched, app.pid, preexisting, pkg.location, process.platform);
    }
    killTree(app.pid, leftovers);

    const problems: string[] = [];
    if (outcome.timedOut)
      problems.push(`asked to quit, it did not exit within ${QUIT_TIMEOUT_MS / 1000} s and was killed`);
    else if (outcome.code !== 0 || outcome.signal !== null)
      problems.push(`asked to quit, it ${describeExit(outcome)}, not 0`);
    if (missing.length > 0) problems.push(`the process listing saw no ${missing.join(", ")} process (saw: ${seen})`);
    if (leftovers.length > 0) {
      problems.push(
        `${leftovers.length} of its processes outlived it (killed now): ${leftovers.map((process) => `${process.pid} ${describeProcesses([process], app.pid)}`).join(", ")}`,
      );
    }
    const written = readdirSync(userDataDir);
    const expected = ["Local State", join("Partitions", "app")];
    const absent = expected.filter((entry) => !existsSync(join(userDataDir, entry)));
    if (absent.length > 0) {
      problems.push(
        `the app did not write ${absent.join(", ")} into its --user-data-dir (found: ${written.join(", ") || "nothing"})`,
      );
    }
    const after = fingerprint(realUserData);
    if (after !== before) {
      problems.push(
        before === "absent"
          ? `the installed app's userData directory ${realUserData} was created`
          : `the installed app's userData directory ${realUserData} changed`,
      );
    }
    if (problems.length > 0) return fail(problems.join("; "));
    return report(
      4,
      name,
      "pass",
      `${note}build profile release, main window ready in ${readyMs} ms; ` +
        `${isWindows ? "taskkill" : "SIGTERM"} → exit 0 in ${quitMs} ms; all ${launched.length} processes gone (${seen}); ` +
        `data written to the fresh --user-data-dir (${written.toSorted().join(", ")}); ` +
        `${realUserData} untouched (${before === "absent" ? "absent before and after" : "unchanged"})`,
    );
  } finally {
    removeUserDataDir(userDataDir);
  }
}

/** Runs a tool, with whether it succeeded and what it printed. */
function runTool(command: string, args: string[]): { ok: boolean; output: string } {
  const ran = spawnSync(command, args, { encoding: "utf8" });
  return { ok: ran.status === 0, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim() || String(ran.error ?? "") };
}

function signatureFacts(pkg: Package): SignatureFacts {
  if (process.platform === "linux") return { platform: "linux" };
  if (isWindows) {
    const output = execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-AuthenticodeSignature -LiteralPath $env:VERIFY_RELEASE_EXE | Select-Object @{n='Status';e={[string]$_.Status}},StatusMessage,@{n='Signer';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", env: { ...process.env, VERIFY_RELEASE_EXE: pkg.executable } },
    );
    const facts: unknown = JSON.parse(output);
    const get = (name: string) => {
      const value: unknown = typeof facts === "object" && facts !== null ? Reflect.get(facts, name) : undefined;
      return typeof value === "string" ? value : undefined;
    };
    return {
      platform: "win32",
      status: get("Status") ?? "Unknown",
      message: get("StatusMessage") ?? "",
      signer: get("Signer"),
    };
  }
  const run = runTool;
  const bundle = pkg.bundle!;
  const display = run("codesign", ["-dv", "--verbose=2", bundle]);
  if (/not signed at all/.test(display.output)) return { platform: "darwin", signature: "unsigned" };
  if (/Signature=adhoc/.test(display.output)) return { platform: "darwin", signature: "adhoc" };
  const authority = /^Authority=(.*)$/m.exec(display.output)?.[1];
  return {
    platform: "darwin",
    signature: "identity",
    authority,
    verify: run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]),
    staple: run("xcrun", ["stapler", "validate", bundle]),
    gatekeeper: run("spctl", ["--assess", "--type", "execute", "--verbose=2", bundle]),
  };
}

function checkSigning(pkg: Package, distribution: boolean): CheckResult {
  const name = "signing and notarization";
  try {
    const verdict = judgeSigning(signatureFacts(pkg), distribution);
    return report(5, name, verdict.status, verdict.reason);
  } catch (err) {
    return report(5, name, "fail", `could not read the signature: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---- main -----------------------------------------------------------------------------------------

/** Runs `pnpm <args>` in apps/desktop with the package manager that runs this script. */
function pnpm(args: string[]): void {
  const manager = process.env.npm_execpath;
  if (!manager) throw new Error("building needs pnpm: run `pnpm verify:release`, or pass --no-build");
  const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(manager);
  const ran = spawnSync(isNodeScript ? process.execPath : manager, [...(isNodeScript ? [manager] : []), ...args], {
    cwd: desktopDir,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const known = ["--no-build", DISTRIBUTION_FLAG, ALLOW_NO_SANDBOX_FLAG];
  const unknown = args.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(" ")}. ${USAGE}`);
  const build = !args.includes("--no-build");
  const distribution = args.includes(DISTRIBUTION_FLAG);
  const allowNoSandbox = args.includes(ALLOW_NO_SANDBOX_FLAG);

  if (build) {
    say("building the release and test bundles and packaging the release app");
    buildCheckedBundles();
    pnpm(["run", "package:release"]);
  }
  const pkg = locatePackage();
  if (!existsSync(pkg.executable)) throw new Error(`${pkg.executable} is missing: run \`pnpm release:desktop\` first`);
  say(`checking ${relative(process.cwd(), pkg.executable) || pkg.executable}`);
  const blocker = process.platform === "linux" ? linuxSandboxBlocker(pkg.executable) : undefined;
  const gate = launchGate(process.platform, blocker, allowNoSandbox);
  if (gate.note) say(gate.note);

  const results: CheckResult[] = [];
  const guard = async (id: number, name: string, check: () => CheckResult | Promise<CheckResult>) => {
    try {
      results.push(await check());
    } catch (err) {
      results.push(
        report(
          id,
          name,
          "fail",
          `the check itself failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
        ),
      );
    }
  };
  await guard(1, "fuses", () => checkFuses(pkg));
  await guard(2, "package contents", () => checkContents(pkg));
  await guard(3, "remote debugging refused", () => checkRefusal(pkg, gate));
  await guard(4, "startup smoke", () => checkStartup(pkg, gate));
  await guard(5, "signing and notarization", () => checkSigning(pkg, distribution));

  const summary = summarize(results);
  say("results");
  for (const line of summary.lines) process.stdout.write(`  ${line}\n`);
  return summary.exitCode;
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (err) {
    process.stderr.write(`verify:release: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
