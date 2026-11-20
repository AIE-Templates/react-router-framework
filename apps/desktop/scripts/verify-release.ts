// `pnpm verify:release`: checks the packaged release app in out/release from the outside, the way it
// will be shipped. This is the one and only place that launches a release package: the launchers of
// scripts/launch.ts refuse to (the release build has no diagnostics to run and its fuses stop the
// inspector-based test driver), so every release launch here is started, watched and ended by this
// script itself.
//
//   node scripts/verify-release.ts [--no-build] [--distribution] [--allow-no-sandbox]
//
// By default it first builds what it checks, through pnpm (as scripts/build.ts requires): the web app
// and the release bundles (`build release --with-web`), the test bundles against the same web build
// (`build test`; check 2 runs verify:build's checks on both), the release package (`package:release`)
// and the test package (`package`, the positive controls of check 3). `--no-build` checks what is on
// disk as it is: out/release, the .vite bundles and out/test.
//
// Five checks, each ending in one result line, `pass`, `fail` or `skipped` with its reason. Skipped
// checks are never counted as passed. The exit status says which of three outcomes the run had:
//   0  verified: checks 1 to 4 passed, and check 5 passed or was skipped for a local package;
//   1  failed: at least one check failed;
//   2  incomplete: nothing failed, but one of checks 1 to 4 was skipped (or check 5, for a package
//      declared for distribution on macOS or Windows): the package was not verified, whatever else
//      passed.
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
//    and with `--remote-debugging-pipe` (given pipes on fds 3 and 4, sent `Browser.getVersion`) must
//    each exit with the refusal's own code and log line (src/startup-signals.ts) as its main process's
//    only line, leave no process behind, never accept a connection on the port nor answer on the
//    pipe. Positive controls: the packaged test app started the same way must answer `/json/version`
//    on the port and the command on the pipe, or the check fails.
// 4. Startup smoke: the release app on a fresh `--user-data-dir`, kept off the system credential
//    store (`--use-mock-keychain` on macOS, `--password-store=basic` on Linux), must have its main
//    process report the release build profile and then its main window ready
//    (MAIN_WINDOW_READY_MESSAGE) within 30 s, then, asked to quit from outside (SIGTERM on macOS and
//    Linux, `taskkill` without /F on Windows, which must itself succeed), exit 0 with every process it
//    created gone. It must have written its data into that directory and left the installed app's
//    userData directory as it was (absent stays absent). The decision is `judgeStartup`.
// 5. Signing: by intended use (scripts/release-verdicts.ts, `judgeSigning`). A local unsigned package
//    is skipped; `--distribution` declares the package is for distribution, where a missing or
//    invalid signature fails (macOS: codesign deep strict verify, stapled notarization, Gatekeeper;
//    Windows: Authenticode). Nothing here needs a signing key. Linux: nothing applies.
// Linux hosts where Chromium's sandbox cannot start (scripts/launch.ts, `linuxSandboxBlocker`) skip
// checks 3 and 4 (exit status 2), saying what would open the gate there, unless `--allow-no-sandbox`
// lets them run with `--no-sandbox`, which their result lines then state. Checks 1, 2 and 5 run
// anyway. The sandbox is probed on the package before this run packages it and again after: packaging
// writes a new chrome-sandbox, so a helper someone made root-owned 4755 only counts with --no-build.
// Processes: every launch is the leader of its own process group (POSIX), and the processes it
// created are told apart from everything else by a listing taken just before it and their start
// times (`launchProcesses`). Nothing the launch did not create is ever counted or killed. An
// interrupted run (SIGINT, SIGTERM, SIGHUP) or one that ends unexpectedly kills what its launches
// created and removes its temporary directories before it exits.
// On macOS every launch carries `--use-mock-keychain` (measured: the release package then encrypts
// its cookies with Chromium's mock key, and the login keychain is neither read for nor given a
// "<product> Safe Storage" item), and a hard deadline that kills the launch's whole process tree. A
// launch that does not get ready in time is killed and fails, never retried: on a machine where the
// mock keychain had no effect, a keychain dialog could be waiting on screen.
// Runs on Node directly (type stripping).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
  launchLocation,
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
  DISTRIBUTION_FLAG,
  judgeRefusal,
  judgeSigning,
  judgeStartup,
  type LaunchGate,
  launchGate,
  type LaunchOutcome,
  launchProcesses,
  type LaunchRoot,
  leftoverProcesses,
  mainLogLines,
  type Manifest,
  parseAuthenticode,
  parsePsListing,
  parseWindowsListing,
  pipeReply,
  type ProcessInfo,
  requiresSigning,
  type ProcessLocation,
  type SignatureFacts,
  type StartupObservation,
  summarize,
} from "./release-verdicts.ts";
import { checkBuiltBundles } from "./verify-build.ts";

const USAGE = `Usage: verify-release.ts [--no-build] [${DISTRIBUTION_FLAG}] [${ALLOW_NO_SANDBOX_FLAG}]`;
/** How long a normal launch may take to report its main window ready, or a control to answer. */
const READY_TIMEOUT_MS = 30_000;
/** How long a refused launch may take to exit. */
const REFUSAL_TIMEOUT_MS = 15_000;
/** How long the app may take to quit once asked, and its helpers to be gone after it. */
const QUIT_TIMEOUT_MS = 15_000;
const LEFTOVER_GRACE_MS = 5_000;
/** How long the output of an exited launch may still take to arrive (its pipes may be shared). */
const OUTPUT_GRACE_MS = 2_000;
/** The DevTools protocol command sent over a pipe, and the id its answer carries. */
const PIPE_COMMAND = { id: 1, method: "Browser.getVersion" };
const isWindows = process.platform === "win32";

function say(line: string): void {
  process.stdout.write(`verify:release: ${line}\n`);
}

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

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

/** The environment for powershell.exe: without the caller's PSModulePath, which a PowerShell 7 parent sets for itself. */
function powershellEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.PSModulePath;
  return env;
}

/** Runs a PowerShell command whose output is UTF-8 JSON, whatever the console's code page. */
function powershellJson(command: string, extra: Record<string, string> = {}): string {
  return execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: powershellEnv(extra) },
  );
}

/** Every process on the machine, with what `launchProcesses` needs. Throws when the listing fails. */
function listProcesses(): ProcessInfo[] {
  if (isWindows) {
    return parseWindowsListing(
      powershellJson(
        "Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine," +
          "@{n='Created';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}}" +
          " | ConvertTo-Json -Compress",
      ),
    );
  }
  return parsePsListing(
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,args="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }),
  );
}

function kill(pid: number, signal: NodeJS.Signals = "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {}
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
  /** Resolves when the main process exited (or was killed at the deadline) and its output is in. */
  exited: Promise<LaunchOutcome>;
  isRunning(): boolean;
  /** Extra stdio streams (fd 3 and up). */
  extra: (Readable | Writable | null)[];
  /** Kills the launch's tree and marks it timed out. */
  expire: () => void;
}

/** One launch: its main process and what tells the processes it created from all others. */
interface Launch {
  app: Running;
  root: LaunchRoot;
  preexisting: ReadonlySet<number>;
  location: ProcessLocation;
}

/** Launches not yet accounted for, and temporary directories not yet removed: what an interruption cleans up. */
const launches = new Set<Launch>();
const tempDirs = new Set<string>();

function tempDir(label: string): string {
  const directory = freshUserDataDir(label);
  tempDirs.add(directory);
  return directory;
}

function dropTempDir(directory: string): void {
  removeUserDataDir(directory);
  tempDirs.delete(directory);
}

/** Kills a running main process's group (POSIX) or tree (Windows); a main process that exited is left alone, its PID may be another's now. */
function killRunningTree(app: Running): void {
  if (!app.isRunning()) return;
  if (isWindows) {
    try {
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {}
  } else {
    kill(-app.pid);
  }
}

/** The processes a launch created that are running now. */
function createdBy(started: Launch): ProcessInfo[] {
  return launchProcesses(listProcesses(), started.root, started.preexisting, started.location, process.platform);
}

/** Kills everything a launch created, and nothing else. */
function terminate(started: Launch, known: readonly ProcessInfo[] = []): void {
  killRunningTree(started.app);
  let created: ProcessInfo[] = [];
  try {
    created = createdBy(started);
  } catch {}
  for (const process of [...known, ...created]) kill(process.pid);
}

/** Tears down every launch and temporary directory still around: on interruption and unexpected exit. */
function cleanUpEverything(): void {
  for (const started of launches) terminate(started);
  launches.clear();
  for (const directory of tempDirs) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
  tempDirs.clear();
}

/**
 * Starts `command` as the leader of its own process group (POSIX), with a hard deadline that kills
 * the whole tree, after listing what runs already. Each line of stdout is passed to `onLine`.
 */
function launch(
  command: string,
  args: string[],
  location: ProcessLocation,
  {
    deadlineMs,
    extraFds = 0,
    env = cleanEnv(),
    onLine,
  }: { deadlineMs: number; extraFds?: number; env?: NodeJS.ProcessEnv; onLine?: (line: string) => void },
): Launch {
  const preexisting = new Set(listProcesses().map((process) => process.pid));
  const spawnedAt = Date.now();
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
  const app: Running = {
    pid,
    stdout: () => stdout,
    stderr: () => stderr,
    exited: Promise.resolve({ code: null, signal: null, timedOut: false, stdout: "" }),
    isRunning: () => running,
    extra: child.stdio.slice(3).map((stream) => stream ?? null),
    expire: () => {
      if (!running) return;
      timedOut = true;
      killRunningTree(app);
    },
  };
  const timer = setTimeout(app.expire, deadlineMs);
  app.exited = new Promise<LaunchOutcome>((resolveExit) => {
    let exit: { code: number | null; signal: string | null } | undefined;
    const settle = () => {
      clearTimeout(timer);
      resolveExit({ code: exit?.code ?? null, signal: exit?.signal ?? null, timedOut, stdout });
    };
    child.once("error", (error) => {
      running = false;
      stderr += `${error.message}\n`;
      settle();
    });
    child.once("exit", (code, signal) => {
      running = false;
      exit = { code, signal };
      // The rest of the output arrives by `close`; a helper holding the pipes open (Windows hands them
      // down) must not hold this up for more than a moment.
      setTimeout(settle, OUTPUT_GRACE_MS).unref();
    });
    child.once("close", () => {
      if (exit !== undefined) settle();
    });
  });
  for (const stream of app.extra) stream?.on("error", () => {});
  const started: Launch = { app, root: { pid, spawnedAt }, preexisting, location };
  launches.add(started);
  return started;
}

/**
 * Once its main process has exited: what the launch created that is still running, after a moment
 * for helpers to follow it, killed and returned. Afterwards the launch is no longer tracked.
 */
async function finish(started: Launch, launched: readonly ProcessInfo[] = []): Promise<ProcessInfo[]> {
  const left = () =>
    leftoverProcesses(
      listProcesses(),
      launched,
      started.root,
      started.preexisting,
      started.location,
      process.platform,
    ).filter((process) => process.pid !== started.root.pid || started.app.isRunning());
  let leftovers = left();
  const until = Date.now() + LEFTOVER_GRACE_MS;
  while (leftovers.length > 0 && Date.now() < until) {
    await sleep(100);
    leftovers = left();
  }
  terminate(started, leftovers);
  launches.delete(started);
  return leftovers;
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

/** Whether anything accepts connections on the port: for the release launch, any listener is too many. */
const listening = async (port: number) => (await accepts(port, "127.0.0.1")) || (await accepts(port, "::1"));

/** The `Browser` a DevTools endpoint reports on `/json/version`, or undefined when there is none. */
async function devtoolsBrowser(port: number): Promise<string | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1_000) });
    const version: unknown = await response.json();
    const browser = typeof version === "object" && version !== null ? Reflect.get(version, "Browser") : undefined;
    return typeof browser === "string" && browser !== "" ? browser : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Talks over a launch's DevTools pipe (fd 3 commands, fd 4 answers): sends PIPE_COMMAND, waits for
 * its answer until the process exits or `waitMs` passes, then ends fd 3. The answer's `result`, if any.
 */
async function askOverPipe(app: Running, waitMs: number): Promise<Record<string, unknown> | undefined> {
  const [commands, replies] = app.extra;
  let received = "";
  if (replies && "setEncoding" in replies) {
    replies.setEncoding("utf8");
    replies.on("data", (chunk: string) => (received += chunk));
  }
  if (commands && "write" in commands) commands.write(`${JSON.stringify(PIPE_COMMAND)}\0`);
  const until = Date.now() + waitMs;
  while (app.isRunning() && Date.now() < until && pipeReply(received, PIPE_COMMAND.id) === undefined) {
    await sleep(20);
  }
  if (commands && "end" in commands) commands.end();
  // Anything already on its way.
  await sleep(50);
  return (
    pipeReply(received, PIPE_COMMAND.id) ?? (received.length > 0 ? { unparsed: received.slice(0, 200) } : undefined)
  );
}

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

/** One release launch with a remote debugging switch, watched until it exits and its processes are gone. */
async function refusedLaunch(
  pkg: Package,
  gate: LaunchGate,
  remoteSwitch: "remote-debugging-port" | "remote-debugging-pipe",
): Promise<{ ok: boolean; reason: string }> {
  const userDataDir = tempDir("verify-release");
  try {
    const port = remoteSwitch === "remote-debugging-port" ? await freePort() : undefined;
    const started = launch(
      pkg.executable,
      [
        ...releaseSwitches(userDataDir, gate),
        port === undefined ? "--remote-debugging-pipe" : `--remote-debugging-port=${port}`,
      ],
      pkg.location,
      { deadlineMs: REFUSAL_TIMEOUT_MS, extraFds: port === undefined ? 2 : 0 },
    );
    const { app } = started;
    let listened = false;
    let answered = false;
    if (port === undefined) {
      // Ask it something it would answer, were the pipe open.
      answered = (await askOverPipe(app, REFUSAL_TIMEOUT_MS)) !== undefined;
    } else {
      // Polled for the whole life of the process, and once more after it.
      while (app.isRunning() && !listened) listened = await listening(port);
      if (listened) app.expire();
    }
    const outcome = await app.exited;
    if (port !== undefined && !listened) listened = await listening(port);
    // Its main process is gone; anything it created must be too.
    const stragglers = await finish(started);
    const verdict = judgeRefusal(outcome, remoteSwitch, { listened, answered }, stragglers);
    const stderr = app.stderr().trim();
    return verdict.ok || stderr === ""
      ? verdict
      : { ...verdict, reason: `${verdict.reason} (stderr: ${stderr.slice(0, 300)})` };
  } finally {
    dropTempDir(userDataDir);
  }
}

/**
 * A positive control: the packaged test app, started the normal test way plus the same remote
 * debugging switch, must answer over it, `/json/version` on the port or the command on the pipe.
 * Otherwise a release launch that did not answer would prove nothing.
 */
async function testPackageAnswers(
  remoteSwitch: "remote-debugging-port" | "remote-debugging-pipe",
): Promise<{ ok: boolean; reason: string }> {
  const userDataDir = tempDir("verify-release-control");
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
    const port = remoteSwitch === "remote-debugging-port" ? await freePort() : undefined;
    const location = launchLocation("packaged", "test", { executable: spec.command });
    const started = launch(
      spec.command,
      [...spec.args, port === undefined ? "--remote-debugging-pipe" : `--remote-debugging-port=${port}`],
      location,
      {
        deadlineMs: READY_TIMEOUT_MS + QUIT_TIMEOUT_MS,
        extraFds: port === undefined ? 2 : 0,
        env: { ...cleanEnv(), ...spec.env },
      },
    );
    const { app } = started;
    let answer: string | undefined;
    if (port === undefined) {
      const reply = await askOverPipe(app, READY_TIMEOUT_MS);
      const product = reply && typeof reply.product === "string" ? reply.product : undefined;
      answer = product;
    } else {
      const until = Date.now() + READY_TIMEOUT_MS;
      while (app.isRunning() && answer === undefined && Date.now() < until) {
        answer = await devtoolsBrowser(port);
        if (answer === undefined) await sleep(50);
      }
    }
    if (app.isRunning()) {
      if (isWindows) killRunningTree(app);
      else kill(app.pid, "SIGTERM");
      const quit = setTimeout(app.expire, QUIT_TIMEOUT_MS);
      await app.exited;
      clearTimeout(quit);
    }
    const outcome = await app.exited;
    await finish(started);
    const how = port === undefined ? "answer Browser.getVersion over the pipe" : "answer /json/version on its port";
    if (answer === undefined) {
      return {
        ok: false,
        reason: `the test package started the same way did not ${how} (it ${describeExit(outcome)})`,
      };
    }
    return { ok: true, reason: `the test package started the same way did ${how} (${answer})` };
  } finally {
    dropTempDir(userDataDir);
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
    const control = await testPackageAnswers(remoteSwitch);
    if (control.ok) passes.push(`--${remoteSwitch} positive control: ${control.reason}`);
    else failures.push(`--${remoteSwitch} positive control failed, so the refusal proves nothing: ${control.reason}`);
  }
  const note = gate.note ? `${gate.note}. ` : "";
  return failures.length > 0
    ? report(3, name, "fail", note + failures.join("; "))
    : report(3, name, "pass", note + passes.join("; "));
}

async function checkStartup(pkg: Package, gate: LaunchGate): Promise<CheckResult> {
  const name = "startup smoke";
  if (!gate.run) return report(4, name, "skipped", gate.note!);
  const note = gate.note ? `${gate.note}. ` : "";
  const realUserData = realUserDataDir(pkg.manifest.productName);
  const before = fingerprint(realUserData);
  const userDataDir = tempDir("verify-release");
  try {
    let profile: string | undefined;
    let readyMs: number | undefined;
    let spawnedAt = Date.now();
    // Assigned at once: a promise runs its executor synchronously.
    let settle: (() => void) | undefined;
    const settled = new Promise<void>((resolveSettled) => {
      settle = resolveSettled;
    });
    const started = launch(pkg.executable, releaseSwitches(userDataDir, gate), pkg.location, {
      // The deadline of the whole launch; reaching ready has its own, below.
      deadlineMs: READY_TIMEOUT_MS + QUIT_TIMEOUT_MS + 5_000,
      onLine(line) {
        // The main process's lines only (`process: "main"`).
        const [record] = mainLogLines(line);
        if (record === undefined) return;
        if (profile === undefined && typeof record.buildProfile === "string") {
          profile = record.buildProfile;
          if (profile !== "release") settle?.();
        }
        if (record.msg === MAIN_WINDOW_READY_MESSAGE && readyMs === undefined) {
          readyMs = Date.now() - spawnedAt;
          settle?.();
        }
      },
    });
    spawnedAt = started.root.spawnedAt;
    const { app } = started;
    void app.exited.then(() => settle?.());
    const readyTimer = setTimeout(() => settle?.(), READY_TIMEOUT_MS);
    await settled;
    clearTimeout(readyTimer);
    const observed: StartupObservation = {
      platform: process.platform,
      rootPid: app.pid,
      profile,
      readyMs,
      readyTimeoutMs: READY_TIMEOUT_MS,
      launched: [],
      leftovers: [],
      userData: { written: [], missing: [] },
      realUserData: { path: realUserData, before, after: before },
    };
    if (readyMs === undefined || profile !== "release") {
      // Whether it ended by itself, before anything here killed it.
      const endedByItself = !app.isRunning();
      killRunningTree(app);
      const outcome = await app.exited;
      await finish(started);
      const verdict = judgeStartup({ ...observed, notReady: { endedByItself, outcome } });
      return report(4, name, verdict.status, note + verdict.reason);
    }

    const launched = createdBy(started);
    // Ask it to quit the way a user's system would.
    const quitStarted = performance.now();
    let requestError: string | undefined;
    if (isWindows) {
      const asked = spawnSync("taskkill", ["/PID", String(app.pid)], { encoding: "utf8" });
      if (asked.status !== 0) {
        requestError = `exit ${asked.status ?? asked.error?.message}: ${(asked.stderr || asked.stdout || "").trim()}`;
      }
    } else {
      kill(app.pid, "SIGTERM");
    }
    const quitTimer = setTimeout(app.expire, QUIT_TIMEOUT_MS);
    const outcome = await app.exited;
    clearTimeout(quitTimer);
    const quitMs = Math.round(performance.now() - quitStarted);
    const leftovers = await finish(started, launched);

    const written = readdirSync(userDataDir).toSorted();
    const expected = ["Local State", join("Partitions", "app")];
    const verdict = judgeStartup({
      ...observed,
      quit: {
        method: isWindows ? "taskkill" : "SIGTERM",
        requestError,
        outcome,
        ms: quitMs,
        timeoutMs: QUIT_TIMEOUT_MS,
      },
      launched,
      leftovers,
      userData: { written, missing: expected.filter((entry) => !existsSync(join(userDataDir, entry))) },
      realUserData: { path: realUserData, before, after: fingerprint(realUserData) },
    });
    return report(4, name, verdict.status, note + verdict.reason);
  } finally {
    dropTempDir(userDataDir);
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
    return parseAuthenticode(
      powershellJson(
        "Get-AuthenticodeSignature -LiteralPath $env:VERIFY_RELEASE_EXE | Select-Object " +
          "@{n='Status';e={[string]$_.Status}},StatusMessage,@{n='Signer';e={$_.SignerCertificate.Subject}} | ConvertTo-Json -Compress",
        { VERIFY_RELEASE_EXE: pkg.executable },
      ),
    );
  }
  const bundle = pkg.bundle!;
  const display = runTool("codesign", ["-dv", "--verbose=2", bundle]);
  if (/not signed at all/.test(display.output)) return { platform: "darwin", signature: "unsigned" };
  if (/Signature=adhoc/.test(display.output)) return { platform: "darwin", signature: "adhoc" };
  const authority = /^Authority=(.*)$/m.exec(display.output)?.[1];
  return {
    platform: "darwin",
    signature: "identity",
    authority,
    verify: runTool("codesign", ["--verify", "--deep", "--strict", "--verbose=2", bundle]),
    staple: runTool("xcrun", ["stapler", "validate", bundle]),
    gatekeeper: runTool("spctl", ["--assess", "--type", "execute", "--verbose=2", bundle]),
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

/** Linux: whether Chromium's sandbox can start for the release package on disk; undefined without one, or elsewhere. */
function probeSandbox(): { blocker: string | undefined } | undefined {
  if (process.platform !== "linux") return undefined;
  const executable = packagedBinary(desktopDir, "release");
  return existsSync(executable) ? { blocker: linuxSandboxBlocker(executable) } : undefined;
}

/** The signals that interrupt a run, and the exit status a shell would give for each. */
const SIGNAL_EXIT: ReadonlyMap<NodeJS.Signals, number> = new Map([
  ["SIGINT", 130],
  ["SIGTERM", 143],
  ["SIGHUP", 129],
]);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const known = ["--no-build", DISTRIBUTION_FLAG, ALLOW_NO_SANDBOX_FLAG];
  const unknown = args.filter((arg) => !known.includes(arg));
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(" ")}. ${USAGE}`);
  const build = !args.includes("--no-build");
  const distribution = args.includes(DISTRIBUTION_FLAG);
  const allowNoSandbox = args.includes(ALLOW_NO_SANDBOX_FLAG);

  // Interrupted, it takes down what its launches created and its temporary directories first.
  for (const [signal, code] of SIGNAL_EXIT) {
    process.once(signal, () => {
      say(`${signal}: stopping every launch and removing temporary directories`);
      cleanUpEverything();
      process.exit(code);
    });
  }
  process.once("exit", cleanUpEverything);

  // Before packaging, which writes a new chrome-sandbox: whether a helper made root-owned 4755 opened the gate.
  const beforeBuild = build ? probeSandbox() : undefined;
  if (build) {
    say("building the web app, the release and test bundles, and packaging the release and test apps");
    pnpm(["run", "build", "release", "--with-web"]);
    pnpm(["run", "build", "test"]);
    pnpm(["run", "package:release"]);
    pnpm(["run", "package"]);
  }
  const pkg = locatePackage();
  if (!existsSync(pkg.executable)) throw new Error(`${pkg.executable} is missing: run \`pnpm release:desktop\` first`);
  say(`checking ${relative(process.cwd(), pkg.executable) || pkg.executable}`);
  const blocker = probeSandbox()?.blocker;
  const helperReset = blocker !== undefined && beforeBuild !== undefined && beforeBuild.blocker === undefined;
  const gate = launchGate(process.platform, blocker, allowNoSandbox, helperReset);
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

  const summary = summarize(results, { signingRequired: requiresSigning(process.platform, distribution) });
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
  } finally {
    cleanUpEverything();
  }
}
