import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

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
      timeout: 30_000,
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

/** Wait for the app AND the end of its output. A helper inheriting a pipe gets a bounded grace period. */
export function monitorDesktopChild(
  child: ChildProcess,
  location: LaunchLocation,
  spawnedAt: number,
  {
    onLine,
    userDataDir,
    requireSmokeResult = false,
    isStopping,
    // A bounded cleanup grace period, not a measured upper limit for Electron to drain.
    drainMs = 3_000,
  }: {
    onLine?: (line: string) => void;
    userDataDir?: string;
    requireSmokeResult?: boolean;
    isStopping?: () => boolean;
    drainMs?: number;
  } = {},
) {
  const stdout = child.stdout;
  if (!stdout) throw new Error("Monitoring a desktop launch requires piped stdout");
  const root: LaunchRoot = { pid: child.pid ?? 0, spawnedAt, userDataDir };
  let resolve!: (code: number | null) => void;
  let reject!: (error: unknown) => void;
  const finished = new Promise<number | null>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  let failure: Error | undefined;
  let drain: NodeJS.Timeout | undefined;
  let closed = false;
  let taskkill: ChildProcess | undefined;
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  // child.kill uses the handle of the process actually spawned, even if Windows has reused its PID.
  const killRoot = () => {
    if (!running()) return;
    try {
      child.kill("SIGKILL");
    } catch (err) {
      process.stderr.write(`Could not stop the app's main process: ${String(err)}\n`);
    }
  };
  const stopTree = () => {
    // Once the main process has exited, reap() checks the identity of each survivor.
    if (!child.pid || !running()) return;
    if (process.platform === "win32") {
      if (taskkill) return;
      taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      taskkill.on("error", killRoot);
      taskkill.once("exit", (code) => {
        if (code !== 0) killRoot();
      });
    } else if (!killIfRunning(-child.pid)) killRoot();
  };
  const stopTaskkill = () => {
    if (!taskkill) return;
    try {
      if (taskkill.exitCode === null && taskkill.signalCode === null) taskkill.kill();
    } catch (err) {
      process.stderr.write(`Could not stop taskkill: ${String(err)}\n`);
    } finally {
      taskkill.unref();
    }
  };
  const abort = (reason: unknown) => {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error(String(reason));
    if (closed) return;
    clearTimeout(drain);
    // Neither a failed tree kill nor a child with undrainable pipes may make the caller wait for
    // exit or close forever. reap() separately checks that the main process and its helpers are gone.
    drain = setTimeout(() => {
      stopTaskkill();
      killRoot();
      child.stdin?.destroy();
      stdout.destroy();
      child.stderr?.destroy();
      child.unref();
      reject(failure);
    }, drainMs);
    try {
      stopTree();
    } catch (err) {
      process.stderr.write(`Could not terminate the app's processes: ${String(err)}\n`);
      killRoot();
    }
  };
  let smokePassed = false;
  if (onLine || requireSmokeResult) {
    const lines = createInterface({ input: stdout, crlfDelay: Infinity });
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
  const profile = verifyBuildProfile(stdout, location.profile).catch((error: unknown) => {
    // A requested dev stop owns the grace period even if stdout closes before the profile arrives.
    if (!isStopping?.()) abort(error);
  });
  child.on("error", (err) => {
    if (child.pid) abort(err);
    else failure ??= err; // An unsuccessful spawn still emits close.
  });
  child.once("exit", () => {
    root.exitedAt = Date.now();
    if (!failure && !closed)
      drain = setTimeout(() => {
        abort(new Error("The app exited but its helpers kept its output open"));
        stdout.destroy();
        child.stderr?.destroy();
      }, drainMs);
  });
  child.once("close", (code) => {
    closed = true;
    clearTimeout(drain);
    stopTaskkill();
    void profile.then(() => {
      if (failure) return reject(failure);
      else if (code === 0 && requireSmokeResult && !smokePassed)
        return reject(new Error("The app exited without a successful SMOKE_RESULT"));
      else return resolve(code);
    });
  });
  const owned = () =>
    launchProcesses(listProcesses(), root, new Set(), location, process.platform).filter(
      (item) => item.pid !== root.pid,
    );

  async function waitForHelpers(): Promise<ProcessInfo[]> {
    const until = Date.now() + drainMs;
    let leftovers = owned();
    while ((leftovers.length || running()) && Date.now() < until) {
      await new Promise((done) => setTimeout(done, 100));
      leftovers = owned();
    }
    return leftovers;
  }

  /** Report forced stops separately from helpers that survived cleanup and invalidate the run. */
  async function reap(): Promise<number[]> {
    if (!child.pid) return [];
    const lingering = await waitForHelpers();
    if (!lingering.length && !running()) return [];
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
    if (running()) throw new Error(`Main process ${child.pid} is still running after cleanup`);
    if (remaining.length)
      throw new Error(`Helpers still running after cleanup: ${remaining.map((item) => item.pid).join(", ")}`);
    return killed;
  }
  return { abort, finished, kill: () => abort(new Error("The test launch was stopped")), reap };
}
