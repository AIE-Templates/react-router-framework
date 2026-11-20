// The decisions of scripts/verify-release.ts, apart from the launches and process listings that feed
// them, so each rule is unit-tested without starting Electron: how results add up, when a launch
// runs, is skipped or runs without the sandbox, what the release asar may contain, what counts as a
// refused remote debugging launch, which processes a launch started and which outlived it, and how a
// signature is judged by the package's intended use.
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
  exitCode: number;
}

/**
 * One line per check and a count of each status. Skipped checks are counted as skipped, never as
 * passed; a check that gives no reason counts as failed, whatever its status. Any failure makes the
 * exit status 1, and only failures do: a skipped check names its reason and leaves the decision to
 * whoever reads it.
 */
export function summarize(results: readonly CheckResult[]): Summary {
  const width = Math.max(...results.map((result) => `${result.id} ${result.name}`.length));
  const lines = results.map(
    (result) =>
      `${result.status.padEnd(8)} ${`${result.id} ${result.name}`.padEnd(width)}  ${result.reason.trim() || "(no reason given)"}`,
  );
  const unexplained = (result: CheckResult) => result.reason.trim() === "";
  const passed = results.filter((result) => result.status === "pass" && !unexplained(result)).length;
  const skipped = results.filter((result) => result.status === "skipped" && !unexplained(result)).length;
  const failed = results.length - passed - skipped;
  lines.push(`${passed} passed, ${failed} failed, ${skipped} skipped`);
  return { lines, passed, failed, skipped, exitCode: failed > 0 ? 1 : 0 };
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
 * it needs, unless the caller passed ALLOW_NO_SANDBOX_FLAG, and then every result says the sandbox
 * was off.
 */
export function launchGate(
  platform: NodeJS.Platform,
  blocker: string | undefined,
  allowNoSandbox: boolean,
): LaunchGate {
  if (platform !== "linux" || blocker === undefined) return { run: true, switches: [] };
  if (allowNoSandbox) {
    return {
      run: true,
      switches: ["--no-sandbox"],
      note: `Chromium's sandbox was DISABLED (--no-sandbox, by ${ALLOW_NO_SANDBOX_FLAG}): ${blocker}`,
    };
  }
  const needs = blocker.includes("euid 0")
    ? "run it as a user other than root"
    : "allow unprivileged user namespaces for this executable (Ubuntu: an AppArmor profile with `userns`, or " +
      "kernel.apparmor_restrict_unprivileged_userns=0; Docker: a seccomp profile allowing clone and unshare), " +
      "or make chrome-sandbox beside it owned by root with mode 4755";
  return {
    run: false,
    switches: [],
    note:
      `Chromium's sandbox cannot start on this host: ${blocker}. To run this check here, ${needs}; ` +
      `or pass ${ALLOW_NO_SANDBOX_FLAG} to run it without the sandbox`,
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

// ---- remote debugging refusal -------------------------------------------------------------------

export interface LaunchOutcome {
  code: number | null;
  signal: string | null;
  /** The verifier killed it at its deadline. */
  timedOut: boolean;
  stdout: string;
}

/** The main-process log lines (JSON objects with a `msg`) in a launch's stdout. */
export function mainLogLines(stdout: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const record: unknown = JSON.parse(line);
      if (typeof record === "object" && record !== null && "msg" in record) lines.push({ ...record });
    } catch {}
  }
  return lines;
}

/** What an exit status says about why the process ended, for messages. */
export function describeExit({ code, signal, timedOut }: Pick<LaunchOutcome, "code" | "signal" | "timedOut">): string {
  if (timedOut) return "did not exit by itself and was killed at the deadline";
  if (signal !== null) return `was ended by ${signal}`;
  if (code === 133 || code === 134) {
    return `exited with code ${code} (a Chromium abort, such as the SUID sandbox FATAL error, before any app code)`;
  }
  return `exited with code ${code}`;
}

/**
 * Whether a release launch with `expectedSwitch` was refused the way src/main/remote-debugging.ts
 * refuses it, and nothing else: exit status REMOTE_DEBUGGING_EXIT_CODE by itself in time, the one
 * refusal log line naming that switch, no build profile line (the refusal comes first, so nothing of
 * the app started), and nobody listening on, or answering over, the debugging endpoint. A process
 * that ends any other way, however early, is not a refusal.
 */
export function judgeRefusal(
  outcome: LaunchOutcome,
  expectedSwitch: string,
  endpoint: { listened: boolean; answered?: boolean },
): { ok: boolean; reason: string } {
  const lines = mainLogLines(outcome.stdout);
  const refusals = lines.filter((line) => line.msg === REMOTE_DEBUGGING_REFUSED_MESSAGE);
  if (endpoint.listened) return { ok: false, reason: "the remote debugging port accepted a connection" };
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
      reason: `it exited with ${REMOTE_DEBUGGING_EXIT_CODE} but printed "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" ${refusals.length} times`,
    };
  }
  if (refusals[0].switch !== expectedSwitch) {
    return { ok: false, reason: `the refusal names ${JSON.stringify(refusals[0].switch)}, not ${expectedSwitch}` };
  }
  if (lines.some((line) => "buildProfile" in line)) {
    return { ok: false, reason: "the app logged its startup line: it ran before refusing" };
  }
  return {
    ok: true,
    reason: `exited ${REMOTE_DEBUGGING_EXIT_CODE} with "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" (${expectedSwitch})`,
  };
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
}

/** Where a package's processes run from: what `appProcesses` (scripts/launch.ts) matches on. */
export interface ProcessLocation {
  command: string;
  processDir: string;
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
 * The processes of one launch in a listing: the main process (`rootPid`), every descendant of it, on
 * POSIX every member of its process group (it is started as a group leader), and every process of the
 * package that was not already running before the launch (`preexisting`), which catches helpers
 * started outside the tree, such as a crash handler that detaches from its parent.
 */
export function launchProcesses(
  listing: readonly ProcessInfo[],
  rootPid: number,
  preexisting: ReadonlySet<number>,
  location: ProcessLocation,
  platform: NodeJS.Platform,
): ProcessInfo[] {
  const ours = new Set<number>([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const process of listing) {
      if (!ours.has(process.pid) && ours.has(process.ppid)) {
        ours.add(process.pid);
        grew = true;
      }
    }
  }
  return listing.filter(
    (process) =>
      process.pid !== 0 &&
      (ours.has(process.pid) ||
        (process.pgid !== undefined && process.pgid === rootPid) ||
        (!preexisting.has(process.pid) && runsFrom(process, location, platform))),
  );
}

/**
 * The processes of a launch still running in `after`, a listing taken once it was asked to quit and
 * its main process exited: any process seen as part of it (`launched`) still there with the same
 * command line (so a reused PID is not mistaken for it), and anything `launchProcesses` would count
 * now (an orphan in its group, a new process of the package).
 */
export function leftoverProcesses(
  after: readonly ProcessInfo[],
  launched: readonly ProcessInfo[],
  rootPid: number,
  preexisting: ReadonlySet<number>,
  location: ProcessLocation,
  platform: NodeJS.Platform,
): ProcessInfo[] {
  const seen = new Map(launched.map((process) => [process.pid, process.command]));
  const now = new Set(launchProcesses(after, rootPid, preexisting, location, platform).map((process) => process.pid));
  return after.filter((process) => seen.get(process.pid) === process.command || now.has(process.pid));
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

/** A tool's first line of output, for messages. */
function first(output: string): string {
  return output.trim().split("\n")[0] ?? "";
}

/** The flag that declares the package is meant for distribution, where it must be signed. */
export const DISTRIBUTION_FLAG = "--distribution";

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
