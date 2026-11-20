import { execFileSync, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

import { verifyBuildProfile, type LaunchLocation } from "./launch.ts";
import { windowsProcess, windowsProcesses } from "./powershell.ts";
import { launchProcesses, parsePsListing, type LaunchRoot, type ProcessInfo } from "./release-verdicts.ts";

/** Every process on the machine, with what `launchProcesses` needs. Throws when the listing fails. */
export function listProcesses(): ProcessInfo[] {
  if (process.platform === "win32") {
    return windowsProcesses();
  }
  return parsePsListing(
    execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,args="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C" },
    }),
  );
}

export function killIfRunning(pid: number): boolean {
  try {
    return process.kill(pid, "SIGKILL");
  } catch (err) {
    if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err;
    return false;
  }
}

/** Kill only this launch's process group (POSIX) or descendants (Windows). */
function killChildTree(child: ChildProcess, root: LaunchRoot, location: LaunchLocation): void {
  if (child.pid === undefined) return;
  if (process.platform !== "win32") {
    killIfRunning(-child.pid);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) {
    try {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 5_000 });
      return;
    } catch {
      // It may have just exited. Windows retains the parent PID on surviving helpers.
    }
  }
  for (const item of launchProcesses(windowsProcesses(), root, new Set(), location, "win32")) {
    if (item.pid !== root.pid) windowsProcess(item, "kill");
  }
}

/** Wait for the app AND the end of its output. A helper inheriting a pipe gets a bounded grace period. */
export function monitorTestChild(
  child: ChildProcess & { stdout: Readable },
  location: LaunchLocation,
  spawnedAt: number,
  {
    onLine,
    userDataDir,
    requireSmokeResult = false,
    drainMs = 3_000,
  }: { onLine?: (line: string) => void; userDataDir?: string; requireSmokeResult?: boolean; drainMs?: number } = {},
) {
  const root: LaunchRoot = { pid: child.pid ?? 0, spawnedAt, userDataDir };
  let failure: Error | undefined;
  let drain: NodeJS.Timeout | undefined;
  const kill = () => killChildTree(child, root, location);
  const abort = (reason: unknown) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error(String(reason));
    try {
      kill();
    } catch (err) {
      process.stderr.write(`Could not terminate the app's processes: ${String(err)}\n`);
    }
  };
  let smokePassed = false;
  if (onLine || requireSmokeResult) {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (failure) return;
      try {
        if (requireSmokeResult && line.startsWith("SMOKE_RESULT ")) {
          const result: unknown = JSON.parse(line.slice("SMOKE_RESULT ".length));
          if (typeof result !== "object" || result === null || !("ok" in result) || result.ok !== true)
            throw new Error("The smoke did not report ok: true");
          smokePassed = true;
        }
        onLine?.(line);
      } catch (err) {
        abort(err);
      }
    });
  }
  const profile = verifyBuildProfile(child.stdout, location.profile).catch(abort);
  const finished = new Promise<number | null>((resolve, reject) => {
    child.once("error", (err) => {
      failure ??= err;
    });
    child.once("exit", () => {
      root.exitedAt = Date.now();
      drain = setTimeout(() => {
        abort(new Error("The app exited but its helpers kept its output open"));
        child.stdout.destroy();
        child.stderr?.destroy();
      }, drainMs);
    });
    child.once("close", (code) => {
      clearTimeout(drain);
      void profile.then(() => {
        if (failure) return reject(failure);
        else if (code === 0 && requireSmokeResult && !smokePassed)
          return reject(new Error("The app exited without a successful SMOKE_RESULT"));
        return resolve(code);
      });
    });
  });
  const owned = () =>
    launchProcesses(listProcesses(), root, new Set(), location, process.platform).filter(
      (item) => item.pid !== root.pid,
    );

  async function waitForHelpers(): Promise<ProcessInfo[]> {
    const until = Date.now() + drainMs;
    let leftovers = owned();
    while (leftovers.length && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 100));
      leftovers = owned();
    }
    return leftovers;
  }

  /** Report forced stops separately from helpers that survived cleanup and invalidate the run. */
  async function reap(): Promise<number[]> {
    if (!child.pid) return [];
    const lingering = await waitForHelpers();
    if (!lingering.length) return [];
    const killed: number[] = [];
    for (const item of lingering) {
      if (process.platform === "win32") {
        if (windowsProcess(item, "kill")) killed.push(item.pid);
      } else {
        // Refresh the identity immediately before signalling; ps times are only precise to a second.
        const same = owned().some(
          (p) => p.pid === item.pid && p.startedAt === item.startedAt && p.command === item.command,
        );
        if (same && killIfRunning(item.pid)) killed.push(item.pid);
      }
    }
    // CIM can retain an exited process in its listing for seconds, even with no executable or command line.
    const remaining = (await waitForHelpers()).filter(
      (item) => process.platform !== "win32" || windowsProcess(item, "check"),
    );
    if (remaining.length)
      throw new Error(`Helpers still running after cleanup: ${remaining.map((item) => item.pid).join(", ")}`);
    return killed;
  }
  return { abort, finished, kill, reap };
}
