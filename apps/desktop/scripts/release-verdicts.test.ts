import { describe, expect, it } from "vitest";

import {
  COOKIE_KEY_CHECKED_MESSAGE,
  COOKIE_KEY_MISMATCH_MESSAGE,
  COOKIE_KEY_STORED_MESSAGE,
  COOKIE_KEY_WRITER_FAILED_FILE,
  COOKIE_KEY_WRITER_WARNINGS,
  REMOTE_DEBUGGING_EXIT_CODE,
  REMOTE_DEBUGGING_REFUSED_MESSAGE,
} from "../src/startup-signals.ts";
import type { AsarEntry } from "./asar.ts";
import { perBundle } from "./build-profile.ts";
import {
  ALLOW_NO_SANDBOX_FLAG,
  checkAsarContents,
  checkBundleLink,
  type CheckResult,
  describeDiagnostics,
  describeExit,
  describeProcesses,
  DIAGNOSTIC_MAIN_LINES,
  DIAGNOSTIC_STDERR_CHARS,
  DISTRIBUTION_FLAG,
  expectedAsarFiles,
  INCOMPLETE_EXIT,
  judgeRefusal,
  judgeSigning,
  judgeWindowsDistribution,
  judgeStartup,
  launchGate,
  type LaunchOutcome,
  controlSandboxArgs,
  launchProcesses,
  type LaunchRoot,
  leftoverProcesses,
  mainLogLines,
  missingKinds,
  observeCookieKey,
  parseAuthenticode,
  parsePsListing,
  parseWindowsListing,
  pipeReply,
  type ProcessInfo,
  type StartupObservation,
  requiresSigning,
  summarize,
} from "./release-verdicts.ts";

function check(id: number, status: CheckResult["status"], reason = "because"): CheckResult {
  return { id, name: `check ${id}`, status, reason };
}

const all = (status5: CheckResult["status"] = "skipped") => [
  check(1, "pass"),
  check(2, "pass"),
  check(3, "pass"),
  check(4, "pass"),
  check(5, status5, "unsigned local package"),
];

describe("result summary", () => {
  it("verifies when checks 1 to 4 pass, a local package's signing check allowed to be skipped", () => {
    const summary = summarize(all());
    expect(summary).toMatchObject({ passed: 4, failed: 0, skipped: 1, exitCode: 0 });
    expect(summary.lines.at(-1)).toBe("4 passed, 0 failed, 1 skipped: verified (exit 0)");
    expect(summary.lines[4]).toMatch(/^skipped +5 check 5 +unsigned local package$/);
    expect(summarize(all("pass")).exitCode).toBe(0);
  });

  it("fails when any check failed, and counts a check without a reason as failed", () => {
    expect(summarize([...all().slice(0, 4), check(5, "fail")])).toMatchObject({ failed: 1, exitCode: 1 });
    const silent = summarize([check(1, "pass"), check(2, "pass"), check(3, "pass"), check(4, "skipped", " ")]);
    expect(silent).toMatchObject({ passed: 3, failed: 1, skipped: 0, exitCode: 1 });
    expect(silent.lines[3]).toContain("(no reason given)");
    expect(silent.lines.at(-1)).toContain("FAILED (exit 1)");
  });

  it("is incomplete, with its own exit status, when a required check was skipped or did not run", () => {
    const skipped = summarize([
      check(1, "pass"),
      check(2, "pass"),
      check(3, "skipped"),
      check(4, "skipped"),
      check(5, "skipped"),
    ]);
    expect(skipped).toMatchObject({ passed: 2, failed: 0, skipped: 3, exitCode: INCOMPLETE_EXIT });
    expect(skipped.lines.at(-1)).toBe(
      "2 passed, 0 failed, 3 skipped: INCOMPLETE, not verified (exit 2): checks 3, 4 did not run",
    );
    expect(summarize([check(1, "pass"), check(2, "pass"), check(3, "pass")]).lines.at(-1)).toContain(
      "check 4 did not run",
    );
    // A failure outranks it.
    expect(summarize([check(1, "fail"), check(3, "skipped")]).exitCode).toBe(1);
  });

  it("counts a skipped signing check as incomplete for a package declared for distribution", () => {
    expect(summarize(all(), { signingRequired: true })).toMatchObject({ exitCode: INCOMPLETE_EXIT });
    expect(summarize(all("pass"), { signingRequired: true }).exitCode).toBe(0);
  });

  it("requires the signing check for distribution only where applications carry an OS signature", () => {
    expect(requiresSigning("darwin", true)).toBe(true);
    expect(requiresSigning("win32", true)).toBe(true);
    expect(requiresSigning("linux", true)).toBe(false);
    expect(requiresSigning("darwin", false)).toBe(false);
  });
});

describe("launch gate", () => {
  const userns =
    "creating an unprivileged user namespace failed (unshare: Operation not permitted), and the setuid sandbox " +
    "helper /out/linux-unpacked/chrome-sandbox is owned by uid 1000 with mode 755 (it needs root and mode 4755)";
  const apparmor =
    "AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1), and the " +
    "setuid sandbox helper /out/linux-unpacked/chrome-sandbox is owned by uid 1000 with mode 755";

  it("launches wherever the sandbox can start, and on every other platform", () => {
    expect(launchGate("linux", undefined, false)).toEqual({ run: true, switches: [] });
    expect(launchGate("darwin", userns, false)).toEqual({ run: true, switches: [] });
    expect(launchGate("win32", userns, true)).toEqual({ run: true, switches: [] });
  });

  it("skips, saying what would open the gate on this host, instead of turning the sandbox off by itself", () => {
    const gate = launchGate("linux", userns, false);
    expect(gate).toMatchObject({ run: false, switches: [] });
    expect(gate.note).toContain(userns);
    expect(gate.note).toContain("allow unprivileged user namespaces");
    expect(gate.note).toContain("root with mode 4755");
    expect(gate.note).toContain("--no-build");
    expect(gate.note).toContain(ALLOW_NO_SANDBOX_FLAG);
    expect(launchGate("linux", "this runs as root (euid 0)", false).note).toContain("as a user other than root");
  });

  it("gives an AppArmor-restricted host only what works there", () => {
    const note = launchGate("linux", apparmor, false).note!;
    expect(note).toContain("chrome-sandbox owned by root with mode 4755");
    expect(note).toContain("run again with --no-build, since packaging replaces it");
    expect(note).toContain("kernel.apparmor_restrict_unprivileged_userns=0");
    expect(note).toContain(ALLOW_NO_SANDBOX_FLAG);
    expect(note).not.toMatch(/AppArmor profile/);
    expect(launchGate("linux", apparmor, false, true).note).toContain("This run's packaging replaced a chrome-sandbox");
  });

  it("runs without the sandbox only on explicit opt-in, and says so", () => {
    const gate = launchGate("linux", userns, true);
    expect(gate).toMatchObject({ run: true, switches: ["--no-sandbox"] });
    expect(gate.note).toMatch(/sandbox was DISABLED/);
  });
});

/** What the archive records as each file's integrity, and what its bytes hash to. */
function digest(path: string): string {
  return `hash of ${path}`;
}

/** The archive's integrity is `hash of <path>`; main.cjs's bytes hash to something else. */
function tamperedDigest(path: string): string {
  return path === ".vite/release/main.cjs" ? "another hash" : `hash of ${path}`;
}

function file(path: string, extra: Partial<AsarEntry> = {}): AsarEntry {
  return { path, kind: "file", size: 1, offset: 0, unpacked: false, integrity: `hash of ${path}`, ...extra };
}

function directory(path: string): AsarEntry {
  return { path, kind: "directory", size: 0, offset: 0, unpacked: false };
}

describe("asar contents", () => {
  const manifest = { name: "desktop", productName: "Desktop", version: "1.0.0" };
  const shipped = { ...manifest, main: ".vite/release/main.cjs" };
  const release = [directory(".vite"), directory(".vite/release"), ...expectedAsarFiles().map((path) => file(path))];

  it("accepts exactly the release manifest and bundles, packed with matching integrity", () => {
    expect(expectedAsarFiles()).toEqual([
      "package.json",
      ".vite/release/main.cjs",
      ".vite/release/preload.cjs",
      ".vite/release/utility.mjs",
    ]);
    const verdict = checkAsarContents(release, shipped, manifest, digest);
    expect(verdict.problems).toEqual([]);
    expect(verdict.findings).toEqual([
      expect.stringContaining("exactly package.json"),
      "package.json enters at .vite/release/main.cjs",
    ]);
  });

  it("names another profile's bundles, stray files, unpacked files and links", () => {
    const entries = [
      ...release,
      directory(".vite/test"),
      file(".vite/test/main.cjs"),
      file(".vite/dev/main.cjs"),
      file("notes.txt"),
      file(".vite/release/main.cjs.map"),
      { ...file("link.js"), kind: "link" as const },
    ].map((entry) => (entry.path === ".vite/release/preload.cjs" ? { ...entry, unpacked: true } : entry));
    expect(checkAsarContents(entries, shipped, manifest, digest).problems).toEqual([
      "app.asar keeps .vite/release/preload.cjs unpacked, outside the archive",
      "app.asar contains .vite/test, content of the test profile",
      "app.asar contains .vite/test/main.cjs, content of the test profile",
      "app.asar contains .vite/dev/main.cjs, content of the dev profile",
      "app.asar contains notes.txt, which is not part of the release package",
      "app.asar contains .vite/release/main.cjs.map, which is not part of the release package",
      "app.asar contains link.js, which is not part of the release package",
    ]);
  });

  it("requires every release file, with the integrity the archive records", () => {
    const entries = release.filter((entry) => entry.path !== ".vite/release/utility.mjs");
    expect(checkAsarContents(entries, shipped, manifest, tamperedDigest).problems).toEqual([
      "the bytes of .vite/release/main.cjs in app.asar do not match the integrity the archive records for them",
      "app.asar does not contain .vite/release/utility.mjs",
    ]);
  });

  it("requires the release entry and the package's identity in the shipped manifest", () => {
    const problems = checkAsarContents(
      release,
      { ...shipped, main: ".vite/test/main.cjs", version: "0.0.1" },
      manifest,
      digest,
    ).problems;
    expect(problems).toEqual([
      'app.asar\'s package.json enters at ".vite/test/main.cjs", not .vite/release/main.cjs',
      'app.asar\'s package.json has version "0.0.1", apps/desktop/package.json "1.0.0"',
    ]);
    expect(checkAsarContents(release, undefined, manifest, digest).problems).toEqual([
      "app.asar's package.json is not an object",
    ]);
  });

  it("ties the shipped bundles to the ones verify:build checked by hash", () => {
    const recorded = perBundle((bundle) => `sha of ${bundle}`.padEnd(64, "0"));
    expect(checkBundleLink(recorded, recorded)).toEqual({
      problems: [],
      findings: [expect.stringContaining("byte for byte the bundles verify:build checked")],
    });
    const stale = { ...recorded, "utility.mjs": "f".repeat(64) };
    expect(checkBundleLink(stale, recorded).problems).toEqual([
      expect.stringMatching(/^\.vite\/release\/utility\.mjs in app\.asar \(sha256 ffffffffffff…\) is not the bundle/),
    ]);
  });
});

/** The refusal's log line as src/main/remote-debugging.ts prints it. */
function refusal(switchName: string): string {
  return JSON.stringify({ level: "error", process: "main", switch: switchName, msg: REMOTE_DEBUGGING_REFUSED_MESSAGE });
}

/** A refused launch's outcome, with `overrides`. */
function outcome(overrides: Partial<LaunchOutcome>): LaunchOutcome {
  return {
    code: REMOTE_DEBUGGING_EXIT_CODE,
    signal: null,
    timedOut: false,
    stdout: `${refusal("remote-debugging-port")}\n`,
    ...overrides,
  };
}

describe("remote debugging refusal", () => {
  const quiet = { listened: false };

  it("accepts only the refusal's own code and line, naming the switch", () => {
    expect(judgeRefusal(outcome({}), "remote-debugging-port", quiet)).toEqual({
      ok: true,
      reason: `exited ${REMOTE_DEBUGGING_EXIT_CODE} with "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" (remote-debugging-port) and nothing else`,
    });
  });

  it.each([
    [
      "a normal exit",
      { code: 0, stdout: "" },
      "exited with code 0, not with the refusal's code 97: it ended for some other reason",
    ],
    ["a startup failure", { code: 1, stdout: "" }, "exited with code 1"],
    // What Node reports for a direct child that Chromium aborted (FATAL, failed CHECK): the signal.
    ["the sandbox abort", { code: null, signal: "SIGTRAP", stdout: "" }, "SIGTRAP (a Chromium abort"],
    ["a Windows abort", { code: 0x80000003, stdout: "" }, "0x80000003 (a Chromium abort)"],
    ["a signal", { code: null, signal: "SIGSEGV", stdout: "" }, "was ended by SIGSEGV"],
    ["the deadline", { code: null, signal: "SIGKILL", timedOut: true }, "killed at the deadline"],
  ])("fails %s, whatever else it printed", (_label, overrides, reason) => {
    const verdict = judgeRefusal(outcome(overrides), "remote-debugging-port", quiet);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(reason);
  });

  it("fails the right code without the main process's line, with another switch, or after the app ran", () => {
    expect(judgeRefusal(outcome({ stdout: "" }), "remote-debugging-port", quiet)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('printed "remote debugging refused" 0 times'),
    });
    // The refusal line of some other process does not count.
    const notMain = JSON.stringify({
      level: "error",
      switch: "remote-debugging-port",
      msg: REMOTE_DEBUGGING_REFUSED_MESSAGE,
    });
    expect(judgeRefusal(outcome({ stdout: `${notMain}\n` }), "remote-debugging-port", quiet).ok).toBe(false);
    expect(judgeRefusal(outcome({}), "remote-debugging-pipe", quiet)).toMatchObject({
      ok: false,
      reason: 'the refusal names "remote-debugging-port", not remote-debugging-pipe',
    });
    // Any other main-process line means the app ran, with or without a build profile in it.
    for (const other of [
      { process: "main", buildProfile: "release", msg: "build profile" },
      { process: "main", msg: "window chrome policy" },
    ]) {
      const ran = `${JSON.stringify(other)}\n${refusal("remote-debugging-port")}\n`;
      expect(judgeRefusal(outcome({ stdout: ran }), "remote-debugging-port", quiet)).toMatchObject({
        ok: false,
        reason: expect.stringContaining("it ran before refusing"),
      });
    }
  });

  it("fails whenever the endpoint answered, even after a proper refusal, and when processes outlive it", () => {
    expect(judgeRefusal(outcome({}), "remote-debugging-port", { listened: true })).toEqual({
      ok: false,
      reason: "the remote debugging port accepted a TCP connection",
    });
    expect(judgeRefusal(outcome({}), "remote-debugging-pipe", { listened: false, answered: true }).ok).toBe(false);
    const straggler: ProcessInfo = { pid: 7, ppid: 1, command: "helper --type=gpu-process" };
    expect(judgeRefusal(outcome({}), "remote-debugging-port", quiet, [straggler])).toEqual({
      ok: false,
      reason: "it left 1 process(es) running after it exited (killed)",
    });
  });

  it("reads only the main process's lines, and a DevTools reply by its id", () => {
    const utility = JSON.stringify({ level: "info", msg: "request completed" });
    expect(mainLogLines(`${utility}\n${refusal("x")}\nnot json\n`)).toEqual([JSON.parse(refusal("x"))]);
    expect(pipeReply(`{"id":2,"result":{}}\0{"id":1,"result":{"product":"Chrome/156"}}\0`, 1)).toEqual({
      product: "Chrome/156",
    });
    expect(pipeReply('{"id":1,"error":{"message":"no"}}\0', 1)).toBeUndefined();
    expect(describeExit({ code: null, signal: "SIGTRAP", timedOut: false })).toContain("Chromium abort");
  });
});

/** A start time `seconds` after 10:00:00 (UTC) on the day of the launches below. */
function at(seconds: number): number {
  return Date.UTC(2026, 10, 20, 10, 0, 0) + seconds * 1000;
}

describe("process accounting", () => {
  const bundle = "/out/Desktop.app";
  const location = { command: `${bundle}/Contents/MacOS/Desktop`, processDir: bundle };
  const helper = (type: string) =>
    `${bundle}/Contents/Frameworks/Desktop Helper.app/Contents/MacOS/Desktop Helper ${type}`;
  // Spawned at 10:00:00.500; `ps` reports whole seconds.
  const spawnedAt = Date.UTC(2026, 10, 20, 10, 0, 0, 500);
  const root: LaunchRoot = { pid: 100, spawnedAt, userDataDir: "/tmp/run space.42" };
  const main: ProcessInfo = { pid: 100, ppid: 1, pgid: 100, command: location.command, startedAt: at(0) };
  const listing: ProcessInfo[] = [
    main,
    { pid: 101, ppid: 100, pgid: 100, command: helper("--type=gpu-process"), startedAt: at(0) },
    {
      pid: 102,
      ppid: 100,
      pgid: 100,
      command: helper("--type=utility --utility-sub-type=network.mojom.NetworkService"),
      startedAt: at(1),
    },
    {
      pid: 103,
      ppid: 100,
      pgid: 100,
      command: helper("--type=utility --utility-sub-type=node.mojom.NodeService"),
      startedAt: at(1),
    },
    { pid: 104, ppid: 100, pgid: 100, command: helper("--type=renderer"), startedAt: at(1) },
    // A crash handler that detached from the tree and its group.
    {
      pid: 105,
      ppid: 1,
      pgid: 105,
      command: `${bundle}/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler --database=/tmp/run space.42/Crashpad`,
      startedAt: at(0),
    },
    // A child of a renderer, and a member of the group that is not in the tree.
    { pid: 106, ppid: 104, pgid: 100, command: "/bin/sh -c something", startedAt: at(2) },
    { pid: 107, ppid: 1, pgid: 100, command: "/usr/bin/orphan", startedAt: at(2) },
    // Not this launch: an instance that was running before, and an unrelated process.
    { pid: 200, ppid: 1, pgid: 200, command: location.command, startedAt: at(-60) },
    { pid: 300, ppid: 1, pgid: 300, command: "/usr/bin/other", startedAt: at(-60) },
    // Already there before the launch, yet arranged to look like its own: a child of the root's PID,
    // a member of its group, a process of the package. None of them is the launch's.
    { pid: 301, ppid: 100, pgid: 100, command: helper("--type=renderer"), startedAt: at(-30) },
    // Exited, waiting to be reaped.
    { pid: 302, ppid: 100, pgid: 100, command: helper("--type=gpu-process"), startedAt: at(1), zombie: true },
  ];
  const preexisting = new Set([200, 300, 301]);

  it("counts the tree, process group and detached helpers carrying the launch profile", () => {
    const launched = launchProcesses(listing, root, preexisting, location, "darwin");
    expect(launched.map((process) => process.pid)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(describeProcesses(launched, 100)).toBe(
      "main, crashpad-handler, gpu-process, other ×2, renderer, utility (network), utility (node)",
    );
    expect(missingKinds(launched, 100)).toEqual([]);
    expect(missingKinds(launched.slice(0, 3), 100)).toEqual(["renderer", "utility (node)"]);
  });

  it("leaves a parallel instance and its helpers alone throughout cleanup", () => {
    const other = [
      { pid: 900, ppid: 1, pgid: 900, command: location.command + " --user-data-dir=/tmp/other", startedAt: at(1) },
      { pid: 901, ppid: 900, pgid: 900, command: helper("--type=renderer"), startedAt: at(2) },
      { pid: 902, ppid: 1, pgid: 902, command: helper("--database=/tmp/run space.420/Crashpad"), startedAt: at(2) },
    ];
    const owned = launchProcesses([...listing, ...other], root, preexisting, location, "darwin");
    expect(owned.some((p) => p.pid >= 900)).toBe(false);
    expect(leftoverProcesses([...other, listing[5]], owned, root, preexisting, location, "darwin")).toEqual([
      listing[5],
    ]);
  });

  it("never counts a process that started before the launch, even one missing from the earlier listing", () => {
    const older: ProcessInfo = {
      pid: 400,
      ppid: 100,
      pgid: 100,
      command: helper("--type=renderer"),
      startedAt: at(-1),
    };
    expect(launchProcesses([...listing, older], root, preexisting, location, "darwin").map((p) => p.pid)).not.toContain(
      400,
    );
  });

  it("allows Linux's ps to report a start up to one second early, no more", () => {
    // procps adds start ticks to a boot time truncated to the second.
    const early = listing.map((process) =>
      process.pid === 100 || process.pid === 101 ? { ...process, startedAt: at(-1) } : process,
    );
    const linux = launchProcesses(early, root, preexisting, location, "linux").map((process) => process.pid);
    expect(linux).toEqual(expect.arrayContaining([100, 101]));
    expect(launchProcesses(early, root, preexisting, location, "darwin").map((process) => process.pid)).not.toContain(
      100,
    );
    const older = { pid: 400, ppid: 100, pgid: 100, command: helper("--type=renderer"), startedAt: at(-2) };
    expect(launchProcesses([...early, older], root, preexisting, location, "linux").map((p) => p.pid)).not.toContain(
      400,
    );
  });

  describe("on Windows", () => {
    const exe = String.raw`C:\out\win-unpacked\Desktop.exe`;
    const winLocation = { command: exe, processDir: String.raw`C:\out\win-unpacked` };
    const winRoot: LaunchRoot = { pid: 10, spawnedAt };

    it("matches by executable and creation time, and counts the key writer as the launch's", () => {
      const windows: ProcessInfo[] = [
        { pid: 10, ppid: 1, command: `"${exe}"`, executable: exe, startedAt: spawnedAt + 5 },
        {
          pid: 11,
          ppid: 10,
          command: `"${exe}" --type=renderer`,
          executable: exe.toUpperCase(),
          startedAt: spawnedAt + 300,
        },
        {
          pid: 12,
          ppid: 99,
          command: "notepad.exe",
          executable: String.raw`C:\Windows\notepad.exe`,
          startedAt: spawnedAt + 400,
        },
        // The cookie key writer a first launch on a fresh profile starts, while it still runs.
        {
          pid: 13,
          ppid: 10,
          command: `"${exe}" --desktop-cookie-key-writer`,
          executable: exe,
          startedAt: spawnedAt + 50,
        },
        // No creation time: on Windows nothing proves it is the launch's.
        { pid: 14, ppid: 10, command: `"${exe}" --type=gpu-process`, executable: exe },
      ];
      const launched = launchProcesses(windows, winRoot, new Set(), winLocation, "win32");
      expect(launched.map((process) => process.pid)).toEqual([10, 11, 13]);
    });

    it("claims the orphan of the exited root, but nothing a later holder of its PID started, nor an old process", () => {
      const after: ProcessInfo[] = [
        // Started by the root, which has exited: Windows keeps its parent PID.
        { pid: 20, ppid: 10, command: `"${exe}" --type=renderer`, executable: exe, startedAt: spawnedAt + 300 },
        // PID 10 reused by an unrelated program long after, and its child.
        {
          pid: 10,
          ppid: 4,
          command: "svchost.exe",
          executable: String.raw`C:\Windows\svchost.exe`,
          startedAt: spawnedAt + 60_000,
        },
        {
          pid: 21,
          ppid: 10,
          command: "conhost.exe",
          executable: String.raw`C:\Windows\conhost.exe`,
          startedAt: spawnedAt + 61_000,
        },
        // Older than the launch, whose dead parent had had PID 10.
        { pid: 22, ppid: 10, command: "old.exe", executable: String.raw`C:\old.exe`, startedAt: spawnedAt - 3_600_000 },
      ];
      const launched = launchProcesses(after, winRoot, new Set(), winLocation, "win32");
      expect(launched.map((process) => process.pid)).toEqual([20]);
      expect(leftoverProcesses(after, [], winRoot, new Set(), winLocation, "win32").map((p) => p.pid)).toEqual([20]);
    });
  });

  it("reports what outlived the main process: never reused PIDs, old processes or zombies", () => {
    const launched = launchProcesses(listing, root, preexisting, location, "darwin");
    expect(
      leftoverProcesses([listing[8], listing[9], listing[10]], launched, root, preexisting, location, "darwin"),
    ).toEqual([]);
    const after: ProcessInfo[] = [
      // Reparented, still the same process.
      { ...listing[4], ppid: 1 },
      // A PID of the launch reused by something unrelated.
      { pid: 101, ppid: 1, pgid: 101, command: "/usr/bin/unrelated", startedAt: at(20) },
      // Still in the group.
      { pid: 400, ppid: 1, pgid: 100, command: "/bin/sleep 100", startedAt: at(3) },
      // A same-package helper of another launch started during the quit.
      { pid: 401, ppid: 1, pgid: 401, command: helper("--type=gpu-process"), startedAt: at(4) },
      // Exited, not yet reaped.
      { ...listing[2], ppid: 1, zombie: true },
      ...listing.slice(8, 11),
    ];
    expect(
      leftoverProcesses(after, launched, root, preexisting, location, "darwin").map((process) => process.pid),
    ).toEqual([104, 400]);
  });

  it("parses ps and the Windows listing, and refuses output that is not one", () => {
    const ps = [
      "    1     0     1 Ss   Wed Nov 11 09:20:13 2026     /sbin/launchd",
      "  731   730   731 Z    Sun Nov  2 07:05:09 2026     (Desktop Helper)",
      "  900     1   900 S    Thu Nov 20 17:25:01 2026     /out/Desktop.app/Contents/MacOS/Desktop --user-data-dir=/tmp/a b",
    ].join("\n");
    const parsed = parsePsListing(ps);
    expect(parsed.map(({ pid, zombie }) => [pid, zombie])).toEqual([
      [1, false],
      [731, true],
      [900, false],
    ]);
    expect(parsed[2].command).toBe("/out/Desktop.app/Contents/MacOS/Desktop --user-data-dir=/tmp/a b");
    expect(parsed[2].startedAt).toBe(new Date(2026, 10, 20, 17, 25, 1).getTime());
    const windows = parseWindowsListing(
      '\uFEFF[{"ProcessId":10,"ParentProcessId":4,"ExecutablePath":"C:\\\\Programme\\\\Désktop.exe","CommandLine":"\\"Désktop.exe\\" --flag","Created":1795166701000}]',
    );
    expect(windows).toEqual([
      {
        pid: 10,
        ppid: 4,
        command: '"Désktop.exe" --flag',
        executable: String.raw`C:\Programme\Désktop.exe`,
        startedAt: 1795166701000,
      },
    ]);
    expect(parseWindowsListing('{"ProcessId":4,"ParentProcessId":0,"Created":null}')).toEqual([
      { pid: 4, ppid: 0, command: "", executable: undefined, startedAt: undefined },
    ]);
    expect(() => parseWindowsListing("Get-CimInstance : Zugriff verweigert")).toThrow(
      "the Windows process listing is not JSON",
    );
  });
});

/** A main-process log record with `msg`. */
function line(msg: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { level: "info", process: "main", msg, ...extra };
}

describe("startup smoke", () => {
  const launched: ProcessInfo[] = [
    { pid: 100, ppid: 1, command: "Desktop" },
    { pid: 101, ppid: 100, command: "Helper --type=renderer" },
    { pid: 102, ppid: 100, command: "Helper --type=utility --utility-sub-type=node.mojom.NodeService" },
  ];
  const exit0: LaunchOutcome = { code: 0, signal: null, timedOut: false, stdout: "" };
  const good: StartupObservation = {
    platform: "darwin",
    rootPid: 100,
    profile: "release",
    readyMs: 812,
    readyTimeoutMs: 30_000,
    quit: { method: "SIGTERM", outcome: exit0, ms: 60, timeoutMs: 15_000 },
    launched,
    leftovers: [],
    userData: { written: ["Local State", "Partitions"], missing: [] },
    realUserData: { path: "/Users/u/Library/Application Support/Desktop", before: "absent", after: "absent" },
    cookieKey: observeCookieKey([], false),
  };

  it("passes a release launch that got ready and quit cleanly, naming the profile it reported", () => {
    expect(judgeStartup(good)).toEqual({
      status: "pass",
      reason: expect.stringMatching(
        /^the main process reported build profile release, main window ready in 812 ms; SIGTERM → exit 0 in 60 ms; all 3 processes gone \(main, renderer, utility \(node\)\)/,
      ),
    });
  });

  it("fails a ready line without a build profile, or with another one", () => {
    expect(judgeStartup({ ...good, profile: undefined })).toEqual({
      status: "fail",
      reason: "the main process reported its main window ready without first reporting its build profile",
    });
    expect(judgeStartup({ ...good, profile: "test" }).reason).toBe(
      'the main process reports build profile "test", not "release"',
    );
  });

  it("fails a launch that never got ready, saying how it ended", () => {
    const notReady = { ...good, readyMs: undefined, quit: undefined };
    expect(
      judgeStartup({
        ...notReady,
        notReady: { endedByItself: false, outcome: { ...exit0, code: null, signal: "SIGKILL" } },
      }).reason,
    ).toBe(
      "its main window was not ready within 30 s; killed with all its processes; a system dialog or a first-launch policy check may be waiting (not retried)",
    );
    expect(
      judgeStartup({
        ...notReady,
        profile: undefined,
        platform: "linux",
        notReady: { endedByItself: true, outcome: { ...exit0, code: null, signal: "SIGTRAP" } },
      }).reason,
    ).toBe(
      "the app was ended by SIGTRAP (a Chromium abort, such as the SUID sandbox FATAL error) without reporting its build profile",
    );
  });

  it("says when the screen was locked at the failure, and never then points at a dialog", () => {
    const notReady = {
      ...good,
      readyMs: undefined,
      quit: undefined,
      notReady: { endedByItself: false, outcome: { ...exit0, code: null, signal: "SIGKILL" } },
    };
    const locked = judgeStartup({ ...notReady, screenAtFailure: { locked: true } }).reason;
    expect(locked).toBe(
      "its main window was not ready within 30 s; killed with all its processes; the macOS screen was locked when it " +
        "was given up on (CGSSessionScreenIsLocked), and macOS reports no window as shown while it is: this says " +
        "nothing about the app; unlock the screen and run again",
    );
    expect(locked).not.toMatch(/keychain|dialog/);
    expect(judgeStartup({ ...notReady, screenAtFailure: { unknown: "ioreg failed" } }).reason).toContain(
      "whether the screen was locked is unknown (ioreg failed); a system dialog",
    );
  });

  it("appends the app's last main-process lines, what ran and a stderr tail to a failure, bounded", () => {
    const mainLines = Array.from({ length: DIAGNOSTIC_MAIN_LINES + 3 }, (_, i) => ({
      ms: i * 100,
      record: {
        level: "info",
        time: "t",
        process: "main",
        msg: `line ${i}`,
        ...(i === 0 ? { buildProfile: "release" } : {}),
      },
    }));
    const reason = judgeStartup({
      ...good,
      readyMs: undefined,
      quit: undefined,
      notReady: { endedByItself: false, outcome: { ...exit0, code: null, signal: "SIGKILL" } },
      screenAtFailure: { locked: false },
      diagnostics: { mainLines, stderr: `${"x".repeat(5000)}\nlast\nwords\n`, running: "main, gpu-process" },
    }).reason;
    expect(reason).toContain("; running then: main, gpu-process; ");
    expect(reason).toContain(
      `last ${DIAGNOSTIC_MAIN_LINES} of ${DIAGNOSTIC_MAIN_LINES + 3} main-process lines: [+300 ms] info line 3 | `,
    );
    expect(reason).not.toContain("line 2 |");
    expect(reason).toContain(
      `[+${(DIAGNOSTIC_MAIN_LINES + 2) * 100} ms] info line ${DIAGNOSTIC_MAIN_LINES + 2}; stderr ends: "…`,
    );
    expect(reason).toMatch(/x ⏎ last ⏎ words"$/);
    expect(reason.length).toBeLessThan(DIAGNOSTIC_MAIN_LINES * 210 + DIAGNOSTIC_STDERR_CHARS + 600);
    // A line's own fields are kept, routine ones dropped; a quiet launch says so.
    expect(describeDiagnostics({ mainLines: mainLines.slice(0, 1), stderr: "" })).toBe(
      '; its main-process lines: [+0 ms] info line 0 {"buildProfile":"release"}; nothing on stderr',
    );
    expect(describeDiagnostics({ mainLines: [], stderr: "", running: "" })).toBe(
      "; running then: nothing; no main-process line; nothing on stderr",
    );
    // A pass carries none of it.
    expect(judgeStartup({ ...good, diagnostics: { mainLines, stderr: "noise" } }).reason).not.toContain("noise");
  });

  const windows = (records: Record<string, unknown>[], failureRecord = false) =>
    judgeStartup({
      ...good,
      platform: "win32",
      quit: { ...good.quit!, method: "taskkill" },
      cookieKey: observeCookieKey(records, failureRecord),
    });

  describe("cookie key writer", () => {
    const storedAndChecked = [line(COOKIE_KEY_STORED_MESSAGE, { ms: 142 }), line(COOKIE_KEY_CHECKED_MESSAGE)];

    it("on Windows requires the key stored by its writer and checked, once each", () => {
      expect(windows(storedAndChecked)).toMatchObject({
        status: "pass",
        reason: expect.stringContaining("; cookie key stored by its writer in 142 ms and checked; "),
      });
      expect(windows([]).reason).toBe(
        'on a fresh profile the cookie key writer must store the key and the launch check it, once each: 0 "stored", 0 "checked" lines',
      );
      expect(windows(storedAndChecked.slice(0, 1)).status).toBe("fail");
      expect(windows([...storedAndChecked, storedAndChecked[0]]).reason).toContain('2 "stored", 1 "checked" lines');
    });

    it("on Windows fails a mismatch, any writer warning and a failure record", () => {
      expect(windows([...storedAndChecked.slice(0, 1), line(COOKIE_KEY_MISMATCH_MESSAGE)]).reason).toContain(
        `the main process logged "${COOKIE_KEY_MISMATCH_MESSAGE}"`,
      );
      for (const warning of COOKIE_KEY_WRITER_WARNINGS) {
        expect(windows([...storedAndChecked, line(warning)])).toEqual({
          status: "fail",
          reason: `the main process logged "${warning}"`,
        });
      }
      expect(windows(storedAndChecked, true).reason).toBe(
        `${COOKIE_KEY_WRITER_FAILED_FILE} was left in the fresh --user-data-dir`,
      );
    });

    it("on macOS and Linux requires that none of these lines appear", () => {
      expect(judgeStartup(good).reason).toContain("; no cookie key writer lines (Windows only); ");
      for (const platform of ["darwin", "linux"] as const) {
        const elsewhere = (records: Record<string, unknown>[], failureRecord = false) =>
          judgeStartup({ ...good, platform, cookieKey: observeCookieKey(records, failureRecord) });
        expect(elsewhere(storedAndChecked).reason).toBe(
          'the cookie key writer ran, which only Windows builds do: 1 "stored", 1 "checked" lines',
        );
        expect(elsewhere([line(COOKIE_KEY_MISMATCH_MESSAGE)]).status).toBe("fail");
        expect(elsewhere([line(COOKIE_KEY_WRITER_WARNINGS[0])]).status).toBe("fail");
        expect(elsewhere([], true).status).toBe("fail");
      }
    });
  });

  it("fails a dirty quit: a failed request, a non-zero exit, a timeout, leftovers, missing processes or data", () => {
    const quit = good.quit!;
    expect(
      judgeStartup({ ...good, quit: { ...quit, method: "taskkill", requestError: "exit 128: ERROR: not found" } })
        .reason,
    ).toBe("asking it to quit (taskkill) failed: exit 128: ERROR: not found");
    expect(judgeStartup({ ...good, quit: { ...quit, outcome: { ...exit0, code: 3 } } }).reason).toBe(
      "asked to quit, it exited with code 3, not 0",
    );
    expect(
      judgeStartup({ ...good, quit: { ...quit, outcome: { ...exit0, code: null, signal: "SIGKILL", timedOut: true } } })
        .reason,
    ).toBe("asked to quit, it did not exit within 15 s and was killed");
    expect(judgeStartup({ ...good, leftovers: [{ pid: 7, ppid: 1, command: "sleep" }] }).reason).toBe(
      "1 of its processes outlived it (killed now): 7 other",
    );
    expect(judgeStartup({ ...good, launched: launched.slice(0, 1) }).reason).toBe(
      "the process listing saw no renderer, utility (node) process (saw: main)",
    );
    expect(judgeStartup({ ...good, userData: { written: [], missing: ["Local State"] } }).reason).toBe(
      "the app did not write Local State into its --user-data-dir (found: nothing)",
    );
    expect(judgeStartup({ ...good, realUserData: { ...good.realUserData, after: ". dir 1" } }).reason).toBe(
      "the installed app's userData directory /Users/u/Library/Application Support/Desktop was created",
    );
  });
});

describe("signing", () => {
  it("skips an unsigned local package and fails it for distribution", () => {
    for (const signature of ["adhoc", "unsigned"] as const) {
      expect(judgeSigning({ platform: "darwin", signature }, false).status).toBe("skipped");
      expect(judgeSigning({ platform: "darwin", signature }, true).status).toBe("fail");
    }
    expect(judgeSigning({ platform: "darwin", signature: "adhoc" }, false).reason).toContain(DISTRIBUTION_FLAG);
    const unsigned = { platform: "win32" as const, status: "NotSigned", message: "The file is not digitally signed." };
    expect(judgeSigning(unsigned, false).status).toBe("skipped");
    expect(judgeSigning(unsigned, true)).toEqual({
      status: "fail",
      reason: "Authenticode status NotSigned: The file is not digitally signed.",
    });
  });

  it("holds a signed package to its signature, notarization and Gatekeeper, whatever its use", () => {
    const ok = { ok: true, output: "accepted\nsource=Notarized Developer ID" };
    const signed = {
      platform: "darwin" as const,
      signature: "identity" as const,
      authority: "Developer ID Application: Example (TEAM)",
      verify: ok,
      staple: ok,
      gatekeeper: ok,
    };
    expect(judgeSigning(signed, true).status).toBe("pass");
    expect(
      judgeSigning({ ...signed, staple: { ok: false, output: "does not have a ticket stapled to it" } }, false),
    ).toEqual({
      status: "fail",
      reason: "no stapled notarization ticket: does not have a ticket stapled to it",
    });
    expect(
      judgeSigning({ ...signed, gatekeeper: { ok: true, output: "accepted\nsource=Developer ID" } }, true).status,
    ).toBe("fail");
    expect(judgeSigning({ platform: "win32", status: "HashMismatch", message: "tampered" }, false).status).toBe("fail");
    expect(judgeSigning({ platform: "win32", status: "Valid", message: "", signer: "CN=Example" }, true)).toEqual({
      status: "pass",
      reason: "Authenticode signature valid: CN=Example",
    });
  });

  it("requires an existing, separately signed NSIS installer for Windows distribution", () => {
    const app = { platform: "win32", status: "Valid", message: "" } as const;
    expect(judgeWindowsDistribution(app, "Setup.exe", undefined)).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("missing distribution installer"),
    });
    expect(judgeWindowsDistribution(app, "Setup.exe", { ...app, status: "NotSigned" }).status).toBe("fail");
    expect(judgeWindowsDistribution(app, "Setup.exe", app).status).toBe("pass");
    expect(judgeWindowsDistribution({ ...app, status: "HashMismatch" }, "Setup.exe", app).status).toBe("fail");
  });

  it("reads Get-AuthenticodeSignature's answer, and refuses one it cannot read", () => {
    expect(
      parseAuthenticode('\uFEFF{"Status":"NotSigned","StatusMessage":"Die Datei ist nicht signiert.","Signer":null}'),
    ).toEqual({
      platform: "win32",
      status: "NotSigned",
      message: "Die Datei ist nicht signiert.",
      signer: undefined,
    });
    expect(() => parseAuthenticode("Get-AuthenticodeSignature : Zugriff verweigert")).toThrow("did not answer in JSON");
    expect(() => parseAuthenticode("{}")).toThrow("gave no Status");
  });

  it("states that nothing applies on Linux", () => {
    expect(judgeSigning({ platform: "linux" }, false)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("repository"),
    });
    expect(judgeSigning({ platform: "linux" }, true).reason).toContain("changes nothing here");
  });
});

describe("the remote-debugging positive control's sandbox", () => {
  it("inherits an explicitly disabled sandbox and rejects test-only fallback", () => {
    expect(controlSandboxArgs(["--other"], { run: true, switches: ["--no-sandbox"] })).toEqual([
      "--other",
      "--no-sandbox",
    ]);
    expect(() => controlSandboxArgs(["--no-sandbox"], { run: true, switches: [] })).toThrow(
      "release package runs with its sandbox",
    );
    expect(controlSandboxArgs([], { run: true, switches: [] })).toEqual([]);
  });
});
