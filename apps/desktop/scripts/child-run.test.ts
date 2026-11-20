import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { monitorTestChild } from "./child-run.ts";
import type { LaunchLocation } from "./launch.ts";
import { windowsProcess, windowsProcesses } from "./powershell.ts";

const location: LaunchLocation = {
  command: process.execPath,
  processDir: dirname(process.execPath),
  target: "unpackaged",
  profile: "test",
};
// Windows puts ordinary children in a job that terminates them when their parent exits.
// These helper fixtures must survive their parent to exercise the launcher's drain and reap paths.
const helperDetached = process.platform === "win32";
const profile = 'console.log(JSON.stringify({process:"main",buildProfile:"test"}));';
function run(script: string, options: Parameters<typeof monitorTestChild>[3] = {}) {
  const at = Date.now();
  const child = spawn(process.execPath, ["-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  return monitorTestChild(child, location, at, options);
}

describe("test child output and cleanup", () => {
  it("rejects spawn errors without waiting for exit", async () => {
    const at = Date.now();
    const child = spawn(join(dirname(process.execPath), "no-such-electron-review-binary"), [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await expect(monitorTestChild(child, location, at).finished).rejects.toThrow(/ENOENT|ENOTDIR/);
  });
  it("requires a successful result from this smoke, even for an early clean exit with the right profile", async () => {
    const options = { requireSmokeResult: true };
    await expect(run(profile, options).finished).rejects.toThrow("without a successful SMOKE_RESULT");
    await expect(run(profile + "console.log('SMOKE_RESULT {\"ok\":false}')", options).finished).rejects.toThrow(
      "did not report ok",
    );
    await expect(run(profile + "console.log('SMOKE_RESULT {\"ok\":true}')", options).finished).resolves.toBe(0);
  });
  it("turns a malformed result line into a run failure and stops the child", async () => {
    const monitor = run(profile + 'console.log("BENCH_RESULT {"); setInterval(()=>{}, 1000)', {
      onLine(line) {
        if (line.startsWith("BENCH_RESULT ")) JSON.parse(line.slice(13));
      },
    });
    await expect(monitor.finished).rejects.toBeInstanceOf(SyntaxError);
  });
  it("reads the final output of helpers before settling, even after the main process exits", async () => {
    // A helper waits for its parent's exit, then writes the result on its inherited output pipe.
    const helper = 'process.stdin.resume(); process.stdin.on("end",()=>console.log(\'SMOKE_RESULT {"ok":true}\'))';
    const script =
      profile +
      'const c = require("node:child_process").spawn(process.execPath, ["-e", ' +
      JSON.stringify(helper) +
      `], {stdio:["pipe",1,2], detached:${helperDetached}}); c.unref(); c.stdin.unref();`;
    await expect(run(script, { requireSmokeResult: true }).finished).resolves.toBe(0);
  });
  it("cleans up its orphaned helper while a concurrent copy of the executable keeps running", async () => {
    const marker = randomUUID();
    let helperPid = 0;
    const launchedAt = Date.now();
    const child = spawn(
      process.execPath,
      [
        "-e",
        profile +
          `const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], {stdio:"ignore", detached:${helperDetached}});` +
          'console.log("helper=" + c.pid); c.unref(); process.stdin.resume(); process.stdin.on("end",()=>{});',
        "--",
        "--user-data-dir=" + marker,
      ],
      { detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] },
    );
    const monitor = monitorTestChild(child, location, launchedAt, {
      userDataDir: marker,
      drainMs: 300,
      onLine(line) {
        if (line.startsWith("helper=")) helperPid = Number(line.slice(7));
      },
    });
    const other = spawn(
      process.execPath,
      ["-e", "setTimeout(()=>{}, 20000)", "--", "--user-data-dir=" + marker + "-other"],
      { detached: process.platform !== "win32", stdio: "ignore" },
    );
    const closed = once(other, "close");
    try {
      child.stdin.end();
      await expect(monitor.finished).resolves.toBe(0);
      expect(helperPid).toBeGreaterThan(0);
      await expect(monitor.reap()).resolves.toEqual([helperPid]);
      await expect(monitor.reap()).resolves.toEqual([]);
      expect(other.exitCode).toBeNull();
      expect(other.signalCode).toBeNull();
      expect(() => process.kill(other.pid!, 0)).not.toThrow();
    } finally {
      other.kill("SIGKILL");
      await closed;
    }
  }, 20000);
  it.runIf(process.platform === "win32")(
    "does not stop a reused or already exited Windows PID",
    async () => {
      const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore" });
      const closed = once(child, "close");
      try {
        const entry = windowsProcesses().find((p) => p.pid === child.pid)!;
        expect(windowsProcess(entry, "check")).toBe(true);
        expect(windowsProcess({ ...entry, startedAt: 1 }, "kill")).toBe(false);
        expect(() => process.kill(child.pid!, 0)).not.toThrow();
        child.kill();
        await closed;
        expect(windowsProcess(entry, "kill")).toBe(false);
      } finally {
        child.kill();
        await closed;
      }
    },
    20000,
  );
  it("bounds draining when a helper holds stdout after its parent exits", async () => {
    const script =
      profile +
      `require("node:child_process").spawn(process.execPath, ["-e","setTimeout(()=>{}, 10000)"], {stdio:["ignore",1,2], detached:${helperDetached}}).unref();`;
    await expect(run(script, { drainMs: 150 }).finished).rejects.toThrow("helpers kept its output open");
  }, 15000);
});
