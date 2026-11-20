// The decisions of scripts/verify-release.ts, apart from the launches and process listings that feed
// them, so each rule is unit-tested without starting Electron: how results add up, when a launch
// runs, is skipped or runs without the sandbox, what the release asar may contain, what counts as a
// refused remote debugging launch, which processes a launch created and which outlived it (never one
// it did not create), how a normal launch is judged (`judgeStartup`), and how a signature is judged
// by the package's intended use.
// Runs on Node directly (type stripping).
import { REMOTE_DEBUGGING_EXIT_CODE, REMOTE_DEBUGGING_REFUSED_MESSAGE } from "../src/startup-signals.ts";
import type { AsarEntry } from "./asar.ts";
import { bundleDir, BUILD_PROFILES, type Bundle, BUNDLES } from "./build-profile.ts";

// ---- results ------------------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  id: number;
  name: string;
  status: CheckStatus;
  /** What was established (pass) or why it failed or was skipped; never empty. */
  reason: string;
}

export interface Summary {
  lines: string[];
  passed: number;
  failed: number;
  skipped: number;
  /** 0 verified, 1 failed, 2 incomplete (VERIFIED_EXIT, FAILED_EXIT, INCOMPLETE_EXIT). */
  exitCode: number;
}

export const VERIFIED_EXIT = 0;
export const FAILED_EXIT = 1;
export const INCOMPLETE_EXIT = 2;

/** The checks that must pass for a package to count as verified; 5 (signing) is judged by intended use. */
export const REQUIRED_CHECKS: readonly number[] = [1, 2, 3, 4];

/**
 * One line per check and a verdict line. Skipped checks are counted as skipped, never as passed; a
 * check that gives no reason counts as failed, whatever its status. The exit status is
 * - FAILED_EXIT when any check failed;
 * - otherwise INCOMPLETE_EXIT when a required check (1 to 4) was skipped, or the signing check was
 *   skipped although `signingRequired` (see `requiresSigning`): nothing failed, but the package was
 *   not verified, and a CI job must not read the run as if it had been;
 * - otherwise VERIFIED_EXIT, the signing check of a local package being allowed to be skipped.
 */
export function summarize(results: readonly CheckResult[], { signingRequired = false } = {}): Summary {
  const width = Math.max(...results.map((result) => `${result.id} ${result.name}`.length));
  const lines = results.map(
    (result) =>
      `${result.status.padEnd(8)} ${`${result.id} ${result.name}`.padEnd(width)}  ${result.reason.trim() || "(no reason given)"}`,
  );
  const unexplained = (result: CheckResult) => result.reason.trim() === "";
  const passed = results.filter((result) => result.status === "pass" && !unexplained(result)).length;
  const skippedResults = results.filter((result) => result.status === "skipped" && !unexplained(result));
  const skipped = skippedResults.length;
  const failed = results.length - passed - skipped;
  const missing = REQUIRED_CHECKS.filter((id) => !results.some((result) => result.id === id));
  const incomplete = [
    ...skippedResults
      .filter((result) => REQUIRED_CHECKS.includes(result.id) || signingRequired)
      .map((result) => result.id),
    ...missing,
  ].toSorted((a, b) => a - b);
  const counts = `${passed} passed, ${failed} failed, ${skipped} skipped`;
  if (failed > 0) {
    lines.push(`${counts}: FAILED (exit ${FAILED_EXIT})`);
    return { lines, passed, failed, skipped, exitCode: FAILED_EXIT };
  }
  if (incomplete.length > 0) {
    lines.push(
      `${counts}: INCOMPLETE, not verified (exit ${INCOMPLETE_EXIT}): check${incomplete.length > 1 ? "s" : ""} ` +
        `${incomplete.join(", ")} did not run`,
    );
    return { lines, passed, failed, skipped, exitCode: INCOMPLETE_EXIT };
  }
  lines.push(`${counts}: verified (exit ${VERIFIED_EXIT})`);
  return { lines, passed, failed, skipped, exitCode: VERIFIED_EXIT };
}

// ---- launch gate --------------------------------------------------------------------------------

export interface LaunchGate {
  /** Whether the release package may be launched here at all. */
  run: boolean;
  /** Chromium switches every launch then gets: `--no-sandbox` only on explicit opt-in. */
  switches: string[];
  /** For a result line: why the launches were skipped, or that they ran without the sandbox. */
  note?: string;
}

/** The flag that lets the verifier launch without Chromium's sandbox where it cannot start. */
export const ALLOW_NO_SANDBOX_FLAG = "--allow-no-sandbox";

/**
 * Whether the launches of checks 3 and 4 run, given why Chromium's sandbox cannot start on this Linux
 * host (`linuxSandboxBlocker`, scripts/launch.ts; undefined when it can, and always elsewhere). The
 * verifier never turns the sandbox off by itself: a host without it skips the launches, saying what
 * would open the gate there, unless the caller passed ALLOW_NO_SANDBOX_FLAG, and then every result
 * says the sandbox was off. `helperReset`: the sandbox could start before this run packaged the app
 * and cannot after it, so packaging replaced a chrome-sandbox someone had made root-owned 4755.
 */
export function launchGate(
  platform: NodeJS.Platform,
  blocker: string | undefined,
  allowNoSandbox: boolean,
  helperReset = false,
): LaunchGate {
  if (platform !== "linux" || blocker === undefined) return { run: true, switches: [] };
  if (allowNoSandbox) {
    return {
      run: true,
      switches: ["--no-sandbox"],
      note: `Chromium's sandbox was DISABLED (--no-sandbox, by ${ALLOW_NO_SANDBOX_FLAG}): ${blocker}`,
    };
  }
  // Packaging writes a new chrome-sandbox, never root-owned 4755: the helper only counts on the
  // package that is checked, so it goes with --no-build.
  const helper =
    "make the package's chrome-sandbox owned by root with mode 4755 (sudo chown root:root …/chrome-sandbox && " +
    "sudo chmod 4755 …/chrome-sandbox) and run again with --no-build, since packaging replaces it";
  const options = blocker.includes("euid 0")
    ? ["run this as a user other than root"]
    : blocker.includes("apparmor_restrict_unprivileged_userns=1")
      ? [helper, "or set kernel.apparmor_restrict_unprivileged_userns=0"]
      : [
          helper,
          "or allow unprivileged user namespaces (kernel.unprivileged_userns_clone=1 and user.max_user_namespaces " +
            "above 0; in Docker a seccomp profile that allows clone and unshare)",
        ];
  const reset = helperReset
    ? " This run's packaging replaced a chrome-sandbox with which the sandbox could start before."
    : "";
  return {
    run: false,
    switches: [],
    note:
      `Chromium's sandbox cannot start on this host: ${blocker}.${reset} To run this check here, ` +
      `${options.join("; ")}; or pass ${ALLOW_NO_SANDBOX_FLAG} to run it without the sandbox`,
  };
}

// ---- asar contents ------------------------------------------------------------------------------

export interface Manifest {
  name: string;
  productName: string;
  version: string;
}

export interface AsarVerdict {
  problems: string[];
  findings: string[];
}

/** What the release archive holds: its manifest and the release bundles, nothing else. */
export function expectedAsarFiles(): string[] {
  return ["package.json", ...BUNDLES.map((bundle) => `${bundleDir("release")}/${bundle}`)];
}

/**
 * Checks the release archive's index and manifest: exactly `expectedAsarFiles()`, every one packed
 * (nothing unpacked beside the archive, no links), nothing of another build profile's bundle
 * directory, and a manifest whose entry is the release main bundle and whose identity is
 * apps/desktop/package.json's. `digest` gives the SHA-256 of a packed file's bytes, compared with the
 * integrity the archive records for it.
 */
export function checkAsarContents(
  entries: readonly AsarEntry[],
  manifest: unknown,
  expected: Manifest,
  digest: (path: string) => string,
): AsarVerdict {
  const problems: string[] = [];
  const findings: string[] = [];
  const files = expectedAsarFiles();
  const directories = new Set(
    files.flatMap((file) =>
      file
        .split("/")
        .slice(0, -1)
        .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
    ),
  );
  const foreignProfiles = BUILD_PROFILES.filter((profile) => profile !== "release");
  for (const entry of entries) {
    const foreign = foreignProfiles.find(
      (profile) => entry.path === bundleDir(profile) || entry.path.startsWith(`${bundleDir(profile)}/`),
    );
    if (foreign !== undefined) {
      problems.push(`app.asar contains ${entry.path}, content of the ${foreign} profile`);
    } else if (entry.kind === "directory" ? !directories.has(entry.path) : !files.includes(entry.path)) {
      problems.push(`app.asar contains ${entry.path}, which is not part of the release package`);
    } else if (entry.kind === "link") {
      problems.push(`app.asar holds ${entry.path} as a link`);
    }
    if (entry.unpacked) problems.push(`app.asar keeps ${entry.path} unpacked, outside the archive`);
  }
  for (const file of files) {
    const entry = entries.find((candidate) => candidate.path === file);
    if (entry === undefined || entry.kind !== "file") {
      problems.push(`app.asar does not contain ${file}`);
      continue;
    }
    if (entry.unpacked) continue;
    if (entry.integrity === undefined) problems.push(`app.asar records no integrity for ${file}`);
    else if (entry.integrity !== digest(file)) {
      problems.push(`the bytes of ${file} in app.asar do not match the integrity the archive records for them`);
    }
  }
  if (problems.length === 0) findings.push(`exactly ${files.join(", ")}, all packed with matching integrity`);

  const main = `${bundleDir("release")}/main.cjs`;
  if (typeof manifest !== "object" || manifest === null) {
    problems.push("app.asar's package.json is not an object");
  } else {
    const field = (name: string): unknown => Reflect.get(manifest, name);
    if (field("main") !== main) {
      problems.push(`app.asar's package.json enters at ${JSON.stringify(field("main"))}, not ${main}`);
    }
    for (const name of ["name", "productName", "version"] as const) {
      if (field(name) !== expected[name]) {
        problems.push(
          `app.asar's package.json has ${name} ${JSON.stringify(field(name))}, apps/desktop/package.json ${JSON.stringify(expected[name])}`,
        );
      }
    }
    if (field("main") === main) findings.push(`package.json enters at ${main}`);
  }
  return { problems, findings };
}

/**
 * Ties each shipped bundle to the bundle scripts/verify-build.ts checked: the SHA-256 of its bytes in
 * the archive must be the one its module record holds (`.vite/release/<bundle>.modules.json`), which
 * that check found equal to the bundle on disk before checking its module list and text.
 */
export function checkBundleLink(
  shipped: Readonly<Record<Bundle, string>>,
  recorded: Readonly<Record<Bundle, string>>,
): AsarVerdict {
  const problems: string[] = [];
  for (const bundle of BUNDLES) {
    if (shipped[bundle] !== recorded[bundle]) {
      problems.push(
        `${bundleDir("release")}/${bundle} in app.asar (sha256 ${shipped[bundle].slice(0, 12)}…) is not the bundle ` +
          `verify:build checked (sha256 ${recorded[bundle].slice(0, 12)}…): repackage, or rebuild and repackage`,
      );
    }
  }
  const findings =
    problems.length === 0
      ? [`${BUNDLES.join(", ")} in app.asar are byte for byte the bundles verify:build checked (sha256)`]
      : [];
  return { problems, findings };
}

// ---- launches -----------------------------------------------------------------------------------

export interface LaunchOutcome {
  code: number | null;
  signal: string | null;
  /** The verifier killed it at its deadline. */
  timedOut: boolean;
  stdout: string;
}

/**
 * The main process's log lines in a launch's stdout: JSON objects with a `msg` and `process: "main"`,
 * as src/main/log.ts writes them (the utility's lines carry no `process: "main"`).
 */
export function mainLogLines(stdout: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record === "object" && record !== null && "msg" in record && "process" in record) {
        if (record.process === "main") lines.push({ ...record });
      }
    } catch {}
  }
  return lines;
}

/** Windows' STATUS_BREAKPOINT, the exit status of a Chromium abort there, as Node reports it either way. */
const WINDOWS_ABORT_CODES = [0x80000003, -0x7ffffffd];

/**
 * What an exit status says about why the process ended, for messages. A Chromium abort (a failed
 * CHECK or a FATAL log, such as the SUID sandbox error) ends a direct child by SIGTRAP on POSIX, which
 * Node reports as the signal, not as a shell's exit code 133.
 */
export function describeExit({ code, signal, timedOut }: Pick<LaunchOutcome, "code" | "signal" | "timedOut">): string {
  if (timedOut) return "did not exit by itself and was killed at the deadline";
  if (signal === "SIGTRAP" || signal === "SIGABRT") {
    return `was ended by ${signal} (a Chromium abort, such as the SUID sandbox FATAL error)`;
  }
  if (signal !== null) return `was ended by ${signal}`;
  if (code !== null && WINDOWS_ABORT_CODES.includes(code)) {
    return `exited with code 0x80000003 (a Chromium abort)`;
  }
  return `exited with code ${code}`;
}

/**
 * Whether a release launch with `expectedSwitch` was refused the way src/main/remote-debugging.ts
 * refuses it, and nothing else: exit status REMOTE_DEBUGGING_EXIT_CODE by itself in time, the one
 * refusal log line naming that switch as the main process's only line (the refusal comes first, so
 * any other line means the app ran), nobody listening on, or answering over, the debugging endpoint,
 * and none of its processes left (`stragglers`, killed by the caller). A process that ends any other
 * way, however early, is not a refusal.
 */
export function judgeRefusal(
  outcome: LaunchOutcome,
  expectedSwitch: string,
  endpoint: { listened: boolean; answered?: boolean },
  stragglers: readonly ProcessInfo[] = [],
): { ok: boolean; reason: string } {
  const lines = mainLogLines(outcome.stdout);
  const refusals = lines.filter((line) => line.msg === REMOTE_DEBUGGING_REFUSED_MESSAGE);
  if (endpoint.listened) return { ok: false, reason: "the remote debugging port answered /json/version" };
  if (endpoint.answered) return { ok: false, reason: "the remote debugging pipe answered a command" };
  if (outcome.timedOut || outcome.signal !== null || outcome.code !== REMOTE_DEBUGGING_EXIT_CODE) {
    return {
      ok: false,
      reason:
        `it ${describeExit(outcome)}, not with the refusal's code ${REMOTE_DEBUGGING_EXIT_CODE}` +
        (refusals.length > 0 ? " (although it printed the refusal)" : ": it ended for some other reason"),
    };
  }
  if (refusals.length !== 1) {
    return {
      ok: false,
      reason: `it exited with ${REMOTE_DEBUGGING_EXIT_CODE} but its main process printed "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" ${refusals.length} times`,
    };
  }
  if (refusals[0].switch !== expectedSwitch) {
    return { ok: false, reason: `the refusal names ${JSON.stringify(refusals[0].switch)}, not ${expectedSwitch}` };
  }
  const others = lines.filter((line) => line !== refusals[0]);
  if (others.length > 0) {
    return {
      ok: false,
      reason: `its main process logged ${others.map((line) => JSON.stringify(line.msg)).join(", ")} as well: it ran before refusing`,
    };
  }
  if (stragglers.length > 0) {
    return { ok: false, reason: `it left ${stragglers.length} process(es) running after it exited (killed)` };
  }
  return {
    ok: true,
    reason: `exited ${REMOTE_DEBUGGING_EXIT_CODE} with "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" (${expectedSwitch}) and nothing else`,
  };
}

/** The `result` of a DevTools protocol reply to command `id` among NUL-separated pipe messages, if any. */
export function pipeReply(data: string, id: number): Record<string, unknown> | undefined {
  for (const message of data.split("\0")) {
    try {
      const parsed: unknown = JSON.parse(message);
      if (typeof parsed !== "object" || parsed === null || !("id" in parsed) || parsed.id !== id) continue;
      if ("result" in parsed && typeof parsed.result === "object" && parsed.result !== null)
        return { ...parsed.result };
    } catch {}
  }
  return undefined;
}

// ---- processes ----------------------------------------------------------------------------------

/** One row of a process listing. */
export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** POSIX process group; Windows has none. */
  pgid?: number;
  /** The full command line (Windows: `CommandLine`). */
  command: string;
  /** Windows: the executable's path. */
  executable?: string;
  /** When it started, in ms since the epoch (POSIX `ps` reports whole seconds), if known. */
  startedAt?: number;
  /** A process that has exited and waits to be reaped (POSIX state Z): nothing runs any more. */
  zombie?: boolean;
}

/**
 * Parses `ps -A -o pid=,ppid=,pgid=,stat=,lstart=,args=` run with LC_ALL=C (macOS and Linux): `lstart`
 * is "Thu Nov 20 17:25:01 2026", local time, whole seconds.
 */
export function parsePsListing(output: string): ProcessInfo[] {
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\s+(.*)$/.exec(
      line,
    );
    if (!match) return [];
    const startedAt = Date.parse(match[5].replace(/\s+/g, " "));
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        zombie: match[4].startsWith("Z"),
        startedAt: Number.isNaN(startedAt) ? undefined : startedAt,
        command: match[6],
      },
    ];
  });
}

/**
 * Parses the JSON of `Get-CimInstance Win32_Process` with ProcessId, ParentProcessId, ExecutablePath,
 * CommandLine and Created (ms since the epoch). Throws, quoting the start of the output, when it is not
 * that JSON, rather than reporting no processes.
 */
export function parseWindowsListing(output: string): ProcessInfo[] {
  let rows: unknown;
  try {
    rows = JSON.parse(output.replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(
      `the Windows process listing is not JSON (${err instanceof Error ? err.message : String(err)}): ${JSON.stringify(output.slice(0, 200))}`,
      { cause: err },
    );
  }
  return (Array.isArray(rows) ? rows : [rows]).flatMap((row: unknown) => {
    if (typeof row !== "object" || row === null) return [];
    const get = (name: string): unknown => Reflect.get(row, name);
    const pid = Number(get("ProcessId"));
    if (!Number.isSafeInteger(pid)) return [];
    const executable = get("ExecutablePath");
    const command = get("CommandLine");
    const created = get("Created");
    return [
      {
        pid,
        ppid: Number(get("ParentProcessId")),
        command: typeof command === "string" ? command : "",
        executable: typeof executable === "string" ? executable : undefined,
        startedAt: typeof created === "number" ? created : undefined,
      },
    ];
  });
}

/** Where a package's processes run from: what `appProcesses` (scripts/launch.ts) matches on. */
export interface ProcessLocation {
  command: string;
  processDir: string;
}

/** A launch: its main process and when this script started it (before the spawn call). */
export interface LaunchRoot {
  pid: number;
  spawnedAt: number;
}

/**
 * Whether a process runs from the package: on POSIX its command line starts with the package's
 * directory (the app bundle on macOS, whose helpers live inside it); on Windows its executable is the
 * package's, which every Electron helper there shares.
 */
export function runsFrom(process: ProcessInfo, location: ProcessLocation, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return process.executable?.toLowerCase() === location.command.toLowerCase();
  return process.command.startsWith(`${location.processDir}/`);
}

/**
 * Whether a process can have been created by the launch: not in the listing taken before it started
 * (`preexisting`), and, where its start time is known, started no earlier than the second the launch
 * was spawned in (`ps` reports whole seconds). Linux's `ps` adds the process's start ticks to a boot
 * time truncated to the second, so it can report a start up to one second early (measured in the
 * CI container: 130 of 200 fresh processes); one more second is allowed there. On Windows the start
 * time is required: parents are never re-parented there and PIDs are reused, so a parent PID proves
 * nothing without it.
 */
function createdByLaunch(
  process: ProcessInfo,
  root: LaunchRoot,
  preexisting: ReadonlySet<number>,
  platform: NodeJS.Platform,
): boolean {
  if (process.pid <= 0 || process.zombie || preexisting.has(process.pid)) return false;
  if (process.startedAt === undefined) return platform !== "win32";
  const earliest = Math.floor(root.spawnedAt / 1000) * 1000 - (platform === "linux" ? 1000 : 0);
  return process.startedAt >= earliest;
}

/**
 * The processes of one launch in a listing, each created by it (`createdByLaunch`): the main process,
 * its descendants, on POSIX the members of its process group (it is started as a group leader), and
 * new processes of the package, which catches helpers started outside the tree, such as a crash
 * handler that detaches from its parent. A process that holds the main process's PID but started
 * after it had already exited (Windows reuses PIDs) is not the main process, and what it started is
 * not the launch's.
 */
export function launchProcesses(
  listing: readonly ProcessInfo[],
  root: LaunchRoot,
  preexisting: ReadonlySet<number>,
  location: ProcessLocation,
  platform: NodeJS.Platform,
): ProcessInfo[] {
  const created = listing.filter((process) => createdByLaunch(process, root, preexisting, platform));
  // A process with the root's PID is a later one when its start is clearly after the spawn.
  const impostor = created.find(
    (process) =>
      process.pid === root.pid && process.startedAt !== undefined && process.startedAt > root.spawnedAt + 5_000,
  );
  const ours = new Set<number>([root.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of created) {
      if (ours.has(process.pid) || !ours.has(process.ppid)) continue;
      // Started after the impostor appeared, under the root's PID: the impostor's child.
      if (
        impostor &&
        process.ppid === root.pid &&
        impostor.startedAt !== undefined &&
        (process.startedAt ?? Infinity) >= impostor.startedAt
      ) {
        continue;
      }
      ours.add(process.pid);
      grew = true;
    }
  }
  return created.filter(
    (process) =>
      process !== impostor &&
      (ours.has(process.pid) ||
        (process.pgid !== undefined && process.pgid === root.pid) ||
        runsFrom(process, location, platform)),
  );
}

/**
 * The processes of a launch still running in `after`, a listing taken once its main process exited:
 * any process seen as part of it (`launched`) still there with the same command line and start (so a
 * reused PID is not mistaken for it), and anything `launchProcesses` would count now (an orphan in its
 * group or tree, a new process of the package). Never anything the launch did not create.
 */
export function leftoverProcesses(
  after: readonly ProcessInfo[],
  launched: readonly ProcessInfo[],
  root: LaunchRoot,
  preexisting: ReadonlySet<number>,
  location: ProcessLocation,
  platform: NodeJS.Platform,
): ProcessInfo[] {
  const seen = new Map(launched.map((process) => [process.pid, process]));
  const now = new Set(launchProcesses(after, root, preexisting, location, platform).map((process) => process.pid));
  return after.filter((process) => {
    if (!createdByLaunch(process, root, preexisting, platform)) return false;
    const earlier = seen.get(process.pid);
    const same =
      earlier !== undefined && earlier.command === process.command && earlier.startedAt === process.startedAt;
    return same || now.has(process.pid);
  });
}

/** What a process of the launch is, from its Chromium `--type`: main, renderer, gpu-process, utility (network), … */
export function processKind(process: ProcessInfo, rootPid: number): string {
  if (process.pid === rootPid) return "main";
  if (/crashpad_handler/i.test(process.command) || /--type=crashpad-handler\b/.test(process.command)) {
    return "crashpad-handler";
  }
  const type = /--type=([\w-]+)/.exec(process.command)?.[1];
  if (type === undefined) return "other";
  if (type !== "utility") return type;
  const subType = /--utility-sub-type=([\w.]+)/.exec(process.command)?.[1] ?? "";
  if (subType.startsWith("node.")) return "utility (node)";
  if (subType.startsWith("network.")) return "utility (network)";
  return subType ? `utility (${subType})` : "utility";
}

/** `main, renderer ×2, …`, in a stable order. */
export function describeProcesses(processes: readonly ProcessInfo[], rootPid: number): string {
  const counts = new Map<string, number>();
  for (const process of processes) {
    const kind = processKind(process, rootPid);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts]
    .toSorted(([a], [b]) => (a === "main" ? -1 : b === "main" ? 1 : a.localeCompare(b)))
    .map(([kind, count]) => (count > 1 ? `${kind} ×${count}` : kind))
    .join(", ");
}

/**
 * The kinds a ready app must have been seen running, or the accounting missed processes and its
 * "nothing left" would prove little: the main process, a renderer and the web server's utility.
 */
export function missingKinds(processes: readonly ProcessInfo[], rootPid: number): string[] {
  const kinds = new Set(processes.map((process) => processKind(process, rootPid)));
  return ["main", "renderer", "utility (node)"].filter((kind) => !kinds.has(kind));
}

// ---- startup smoke ------------------------------------------------------------------------------

/** What scripts/verify-release.ts observed of one normal release launch. */
export interface StartupObservation {
  platform: NodeJS.Platform;
  rootPid: number;
  /** The `buildProfile` of the main process's first line that reported one, if any. */
  profile?: string;
  /** Whether the main process logged MAIN_WINDOW_READY_MESSAGE, and when (ms since the spawn). */
  readyMs?: number;
  readyTimeoutMs: number;
  /** How the launch ended when it never became ready: by itself, or killed at the deadline. */
  notReady?: { endedByItself: boolean; outcome: LaunchOutcome };
  /** Asking it to quit from outside and what followed. */
  quit?: {
    method: string;
    /** The quit request itself failed (a non-zero `taskkill`), with what it said. */
    requestError?: string;
    outcome: LaunchOutcome;
    ms: number;
    timeoutMs: number;
  };
  launched: readonly ProcessInfo[];
  leftovers: readonly ProcessInfo[];
  /** Entries of the fresh --user-data-dir, and the expected ones it lacks. */
  userData: { written: readonly string[]; missing: readonly string[] };
  realUserData: { path: string; before: string; after: string };
}

function failure(reason: string): { status: CheckStatus; reason: string } {
  return { status: "fail", reason };
}

/**
 * Check 4's verdict. The main process must first report the release build profile, then its main
 * window ready; a ready line without a reported profile, or with another one, is a failure, not a
 * pass. Asked to quit, it must exit 0 by itself, the quit request must have worked, the accounting
 * must have seen the processes a ready app has, none may outlive it, its data must be in the fresh
 * directory and the installed app's userData must be as it was.
 */
export function judgeStartup(observed: StartupObservation): { status: CheckStatus; reason: string } {
  const fail = failure;
  const seconds = observed.readyTimeoutMs / 1000;
  if (observed.profile !== undefined && observed.profile !== "release") {
    return fail(`the main process reports build profile ${JSON.stringify(observed.profile)}, not "release"`);
  }
  if (observed.readyMs !== undefined && observed.profile === undefined) {
    return fail("the main process reported its main window ready without first reporting its build profile");
  }
  if (observed.readyMs === undefined || observed.notReady !== undefined || observed.quit === undefined) {
    const notReady = observed.notReady;
    if (notReady?.endedByItself) {
      return fail(
        `the app ${describeExit(notReady.outcome)} ` +
          (observed.profile === undefined ? "without reporting its build profile" : "before its main window was ready"),
      );
    }
    const keychain = observed.platform === "darwin" ? "; a keychain dialog may be waiting on screen (not retried)" : "";
    return fail(
      `${observed.profile === undefined ? "the app did not report its build profile" : "its main window was not ready"} ` +
        `within ${seconds} s; killed with all its processes${keychain}`,
    );
  }
  const { quit } = observed;
  const problems: string[] = [];
  if (quit.requestError !== undefined) problems.push(`asking it to quit (${quit.method}) failed: ${quit.requestError}`);
  if (quit.outcome.timedOut) {
    problems.push(`asked to quit, it did not exit within ${quit.timeoutMs / 1000} s and was killed`);
  } else if (quit.outcome.code !== 0 || quit.outcome.signal !== null) {
    problems.push(`asked to quit, it ${describeExit(quit.outcome)}, not 0`);
  }
  const seen = describeProcesses(observed.launched, observed.rootPid);
  const missing = missingKinds(observed.launched, observed.rootPid);
  if (missing.length > 0) problems.push(`the process listing saw no ${missing.join(", ")} process (saw: ${seen})`);
  if (observed.leftovers.length > 0) {
    problems.push(
      `${observed.leftovers.length} of its processes outlived it (killed now): ` +
        observed.leftovers.map((process) => `${process.pid} ${processKind(process, observed.rootPid)}`).join(", "),
    );
  }
  if (observed.userData.missing.length > 0) {
    problems.push(
      `the app did not write ${observed.userData.missing.join(", ")} into its --user-data-dir ` +
        `(found: ${observed.userData.written.join(", ") || "nothing"})`,
    );
  }
  const real = observed.realUserData;
  if (real.after !== real.before) {
    problems.push(
      real.before === "absent"
        ? `the installed app's userData directory ${real.path} was created`
        : `the installed app's userData directory ${real.path} changed`,
    );
  }
  if (problems.length > 0) return fail(problems.join("; "));
  return {
    status: "pass",
    reason:
      `the main process reported build profile ${observed.profile}, main window ready in ${observed.readyMs} ms; ` +
      `${quit.method} → exit 0 in ${quit.ms} ms; all ${observed.launched.length} processes gone (${seen}); ` +
      `data written to the fresh --user-data-dir (${observed.userData.written.toSorted().join(", ")}); ` +
      `${real.path} untouched (${real.before === "absent" ? "absent before and after" : "unchanged"})`,
  };
}

// ---- signing ------------------------------------------------------------------------------------

/** What scripts/verify-release.ts found out about the package's signature. */
export type SignatureFacts =
  | {
      platform: "darwin";
      /** `codesign -dv`: unsigned, ad-hoc (what a local build carries), or signed by an identity. */
      signature: "unsigned" | "adhoc" | "identity";
      /** The signing authority chain codesign printed, for messages. */
      authority?: string;
      /** `codesign --verify --deep --strict`. */
      verify?: { ok: boolean; output: string };
      /** `xcrun stapler validate`: a notarization ticket is stapled. */
      staple?: { ok: boolean; output: string };
      /** `spctl --assess --type execute`: Gatekeeper accepts it as notarized. */
      gatekeeper?: { ok: boolean; output: string };
    }
  | {
      platform: "win32";
      /** `Get-AuthenticodeSignature`'s Status: Valid, NotSigned, HashMismatch, NotTrusted, … */
      status: string;
      message: string;
      signer?: string;
    }
  | { platform: "linux" };

/**
 * Parses the JSON of `Get-AuthenticodeSignature … | Select-Object Status,StatusMessage,Signer`.
 * Throws, quoting the output, when it is not that JSON: an unreadable answer is no signature verdict.
 */
export function parseAuthenticode(output: string): Extract<SignatureFacts, { platform: "win32" }> {
  let facts: unknown;
  try {
    facts = JSON.parse(output.replace(/^﻿/, ""));
  } catch (err) {
    throw new Error(
      `Get-AuthenticodeSignature did not answer in JSON (${err instanceof Error ? err.message : String(err)}): ${JSON.stringify(output.slice(0, 200))}`,
      { cause: err },
    );
  }
  const get = (name: string) => {
    const value: unknown = typeof facts === "object" && facts !== null ? Reflect.get(facts, name) : undefined;
    return typeof value === "string" ? value : undefined;
  };
  const status = get("Status");
  if (status === undefined)
    throw new Error(`Get-AuthenticodeSignature gave no Status: ${JSON.stringify(output.slice(0, 200))}`);
  return { platform: "win32", status, message: get("StatusMessage") ?? "", signer: get("Signer") };
}

/** A tool's first line of output, for messages. */
function first(output: string): string {
  return output.trim().split("\n")[0] ?? "";
}

/** The flag that declares the package is meant for distribution, where it must be signed. */
export const DISTRIBUTION_FLAG = "--distribution";

/**
 * Whether the signing check must pass for the run to verify the package: for a package declared for
 * distribution, on the platforms where an application carries an OS signature (not Linux).
 */
export function requiresSigning(platform: NodeJS.Platform, distribution: boolean): boolean {
  return distribution && platform !== "linux";
}

/**
 * Judges a package's signature by its intended use. A local package without a real signature is
 * skipped, saying so; declared for distribution (DISTRIBUTION_FLAG) a missing or invalid signature
 * fails. A package that does carry a signature is always held to it: on macOS a deep strict verify,
 * a stapled notarization ticket and Gatekeeper's assessment; on Windows a valid Authenticode
 * signature. Linux has no OS-level signature on an application: deb and rpm packages are signed by
 * the repository that publishes them, so there is nothing to check here either way.
 */
export function judgeSigning(facts: SignatureFacts, distribution: boolean): { status: CheckStatus; reason: string } {
  if (facts.platform === "linux") {
    return {
      status: "skipped",
      reason:
        "Linux has no OS code signature on an application; deb and rpm packages are signed (GPG) by the " +
        `repository that publishes them, outside this package${distribution ? ` (${DISTRIBUTION_FLAG} changes nothing here)` : ""}`,
    };
  }
  if (facts.platform === "win32") {
    if (facts.status === "Valid") {
      return { status: "pass", reason: `Authenticode signature valid${facts.signer ? `: ${facts.signer}` : ""}` };
    }
    if (facts.status === "NotSigned" && !distribution) {
      return {
        status: "skipped",
        reason: `unsigned local package (Authenticode: NotSigned); ${DISTRIBUTION_FLAG} makes this a failure`,
      };
    }
    return { status: "fail", reason: `Authenticode status ${facts.status}: ${facts.message}` };
  }
  if (facts.signature !== "identity") {
    const what = facts.signature === "adhoc" ? "ad-hoc signature only, no signing identity" : "not signed at all";
    if (!distribution) {
      return {
        status: "skipped",
        reason: `unsigned local package (${what}); ${DISTRIBUTION_FLAG} makes this a failure`,
      };
    }
    return { status: "fail", reason: `a package for distribution must be signed with a Developer ID: ${what}` };
  }
  const failures: string[] = [];
  if (!facts.verify?.ok)
    failures.push(`codesign --verify --deep --strict failed: ${first(facts.verify?.output ?? "not run")}`);
  if (!facts.staple?.ok) failures.push(`no stapled notarization ticket: ${first(facts.staple?.output ?? "not run")}`);
  if (!facts.gatekeeper?.ok || !/source=Notarized Developer ID/.test(facts.gatekeeper.output)) {
    failures.push(`Gatekeeper does not accept it as notarized: ${first(facts.gatekeeper?.output ?? "not run")}`);
  }
  if (failures.length > 0) return { status: "fail", reason: failures.join("; ") };
  return {
    status: "pass",
    reason: `signed${facts.authority ? ` by ${facts.authority}` : ""}, verified deep and strict, notarized and stapled, accepted by Gatekeeper`,
  };
}
