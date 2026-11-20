import { describe, expect, it } from "vitest";

import { REMOTE_DEBUGGING_EXIT_CODE, REMOTE_DEBUGGING_REFUSED_MESSAGE } from "../src/startup-signals.ts";
import type { AsarEntry } from "./asar.ts";
import { perBundle } from "./build-profile.ts";
import {
  ALLOW_NO_SANDBOX_FLAG,
  checkAsarContents,
  checkBundleLink,
  type CheckResult,
  describeProcesses,
  DISTRIBUTION_FLAG,
  expectedAsarFiles,
  judgeRefusal,
  judgeSigning,
  launchGate,
  type LaunchOutcome,
  launchProcesses,
  leftoverProcesses,
  missingKinds,
  type ProcessInfo,
  summarize,
} from "./release-verdicts.ts";

function check(id: number, status: CheckResult["status"], reason = "because"): CheckResult {
  return { id, name: `check ${id}`, status, reason };
}

describe("result summary", () => {
  it("passes with skips, counting them as skipped and never as passed", () => {
    const summary = summarize([check(1, "pass"), check(2, "pass"), check(5, "skipped", "unsigned local package")]);
    expect(summary).toMatchObject({ passed: 2, failed: 0, skipped: 1, exitCode: 0 });
    expect(summary.lines.at(-1)).toBe("2 passed, 0 failed, 1 skipped");
    expect(summary.lines[2]).toMatch(/^skipped +5 check 5 +unsigned local package$/);
  });

  it("fails when any check failed, and counts a check without a reason as failed", () => {
    expect(summarize([check(1, "pass"), check(2, "fail")])).toMatchObject({ failed: 1, exitCode: 1 });
    const silent = summarize([check(1, "pass"), check(4, "skipped", " ")]);
    expect(silent).toMatchObject({ passed: 1, failed: 1, skipped: 0, exitCode: 1 });
    expect(silent.lines[1]).toContain("(no reason given)");
  });
});

describe("launch gate", () => {
  const blocker = "creating an unprivileged user namespace failed (unshare: Operation not permitted)";

  it("launches wherever the sandbox can start, and on every other platform", () => {
    expect(launchGate("linux", undefined, false)).toEqual({ run: true, switches: [] });
    expect(launchGate("darwin", blocker, false)).toEqual({ run: true, switches: [] });
    expect(launchGate("win32", blocker, true)).toEqual({ run: true, switches: [] });
  });

  it("skips, saying what the host needs, instead of turning the sandbox off by itself", () => {
    const gate = launchGate("linux", blocker, false);
    expect(gate).toMatchObject({ run: false, switches: [] });
    expect(gate.note).toContain(blocker);
    expect(gate.note).toContain("allow unprivileged user namespaces");
    expect(gate.note).toContain(ALLOW_NO_SANDBOX_FLAG);
    expect(launchGate("linux", "this runs as root (euid 0)", false).note).toContain("as a user other than root");
  });

  it("runs without the sandbox only on explicit opt-in, and says so", () => {
    const gate = launchGate("linux", blocker, true);
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
      reason: `exited ${REMOTE_DEBUGGING_EXIT_CODE} with "${REMOTE_DEBUGGING_REFUSED_MESSAGE}" (remote-debugging-port)`,
    });
  });

  it.each([
    [
      "a normal exit",
      { code: 0, stdout: "" },
      "exited with code 0, not with the refusal's code 97: it ended for some other reason",
    ],
    ["a startup failure", { code: 1, stdout: "" }, "exited with code 1"],
    ["the sandbox abort", { code: 133, stdout: "" }, "Chromium abort, such as the SUID sandbox FATAL error"],
    ["a signal", { code: null, signal: "SIGSEGV", stdout: "" }, "was ended by SIGSEGV"],
    ["the deadline", { code: null, signal: "SIGKILL", timedOut: true }, "killed at the deadline"],
  ])("fails %s, whatever else it printed", (_label, overrides, reason) => {
    const verdict = judgeRefusal(outcome(overrides), "remote-debugging-port", quiet);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain(reason);
  });

  it("fails the right code without the line, with another switch, or after the app started", () => {
    expect(judgeRefusal(outcome({ stdout: "" }), "remote-debugging-port", quiet)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('printed "remote debugging refused" 0 times'),
    });
    expect(judgeRefusal(outcome({}), "remote-debugging-pipe", quiet)).toMatchObject({
      ok: false,
      reason: 'the refusal names "remote-debugging-port", not remote-debugging-pipe',
    });
    const started = `${JSON.stringify({ process: "main", buildProfile: "release", msg: "build profile" })}\n${refusal("remote-debugging-port")}\n`;
    expect(judgeRefusal(outcome({ stdout: started }), "remote-debugging-port", quiet).ok).toBe(false);
  });

  it("fails whenever the endpoint was reachable, even after a proper refusal", () => {
    expect(judgeRefusal(outcome({}), "remote-debugging-port", { listened: true })).toEqual({
      ok: false,
      reason: "the remote debugging port accepted a connection",
    });
    expect(judgeRefusal(outcome({}), "remote-debugging-pipe", { listened: false, answered: true }).ok).toBe(false);
  });
});

describe("process accounting", () => {
  const bundle = "/out/Desktop.app";
  const location = { command: `${bundle}/Contents/MacOS/Desktop`, processDir: bundle };
  const helper = (type: string) =>
    `${bundle}/Contents/Frameworks/Desktop Helper.app/Contents/MacOS/Desktop Helper ${type}`;
  const root: ProcessInfo = { pid: 100, ppid: 1, pgid: 100, command: location.command };
  const listing: ProcessInfo[] = [
    root,
    { pid: 101, ppid: 100, pgid: 100, command: helper("--type=gpu-process") },
    {
      pid: 102,
      ppid: 100,
      pgid: 100,
      command: helper("--type=utility --utility-sub-type=network.mojom.NetworkService"),
    },
    { pid: 103, ppid: 100, pgid: 100, command: helper("--type=utility --utility-sub-type=node.mojom.NodeService") },
    { pid: 104, ppid: 100, pgid: 100, command: helper("--type=renderer") },
    // A crash handler that detached from the tree and its group.
    {
      pid: 105,
      ppid: 1,
      pgid: 105,
      command: `${bundle}/Contents/Frameworks/Electron Framework.framework/Helpers/chrome_crashpad_handler`,
    },
    // A child of a renderer, and a member of the group that is not in the tree.
    { pid: 106, ppid: 104, pgid: 100, command: "/bin/sh -c something" },
    { pid: 107, ppid: 1, pgid: 100, command: "/usr/bin/orphan" },
    // Not this launch: an instance that was running before, and an unrelated process.
    { pid: 200, ppid: 1, pgid: 200, command: location.command },
    { pid: 300, ppid: 1, pgid: 300, command: "/usr/bin/other" },
  ];
  const preexisting = new Set([200, 300]);

  it("counts the tree, the process group and new processes of the package, nothing else", () => {
    const launched = launchProcesses(listing, 100, preexisting, location, "darwin");
    expect(launched.map((process) => process.pid)).toEqual([100, 101, 102, 103, 104, 105, 106, 107]);
    expect(describeProcesses(launched, 100)).toBe(
      "main, crashpad-handler, gpu-process, other ×2, renderer, utility (network), utility (node)",
    );
    expect(missingKinds(launched, 100)).toEqual([]);
    expect(missingKinds(launched.slice(0, 3), 100)).toEqual(["renderer", "utility (node)"]);
  });

  it("matches Windows processes by executable, without process groups", () => {
    const exe = String.raw`C:\out\win-unpacked\Desktop.exe`;
    const windows: ProcessInfo[] = [
      { pid: 10, ppid: 1, command: `"${exe}"`, executable: exe },
      { pid: 11, ppid: 99, command: `"${exe}" --type=renderer`, executable: exe.toUpperCase() },
      { pid: 12, ppid: 99, command: "notepad.exe", executable: String.raw`C:\Windows\notepad.exe` },
    ];
    const launched = launchProcesses(
      windows,
      10,
      new Set(),
      { command: exe, processDir: String.raw`C:\out\win-unpacked` },
      "win32",
    );
    expect(launched.map((process) => process.pid)).toEqual([10, 11]);
  });

  it("reports what outlived the main process, ignoring reused PIDs and what was there before", () => {
    const launched = launchProcesses(listing, 100, preexisting, location, "darwin");
    expect(leftoverProcesses([listing[8], listing[9]], launched, 100, preexisting, location, "darwin")).toEqual([]);
    const after: ProcessInfo[] = [
      // Reparented, still the same process.
      { ...listing[4], ppid: 1 },
      // A PID of the launch reused by something unrelated.
      { pid: 101, ppid: 1, pgid: 101, command: "/usr/bin/unrelated" },
      // Still in the group.
      { pid: 400, ppid: 1, pgid: 100, command: "/bin/sleep 100" },
      // A new process of the package started during the quit.
      { pid: 401, ppid: 1, pgid: 401, command: helper("--type=gpu-process") },
      listing[8],
      listing[9],
    ];
    expect(
      leftoverProcesses(after, launched, 100, preexisting, location, "darwin").map((process) => process.pid),
    ).toEqual([104, 400, 401]);
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

  it("states that nothing applies on Linux", () => {
    expect(judgeSigning({ platform: "linux" }, false)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("repository"),
    });
    expect(judgeSigning({ platform: "linux" }, true).reason).toContain("changes nothing here");
  });
});
