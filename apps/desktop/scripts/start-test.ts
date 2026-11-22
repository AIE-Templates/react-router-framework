// `pnpm --dir apps/desktop start:test`: launches the test profile (unpackaged, --packaged, or --app)
// via scripts/launch.ts on a fresh user data directory unless `--user-data-dir` is supplied.
// Usage: node scripts/start-test.ts [--packaged | --app <executable>] [electron arguments...]
// Runs on Node directly (type stripping).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

import { monitorDesktopChild } from "./child-run.ts";
import { checkLaunchInputs, freshUserDataDir, launchSpec, removeUserDataDir } from "./launch.ts";

function fail(err: unknown): never {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
let executable: string | undefined;
let packaged = false;
if (args[0] === "--packaged") {
  packaged = true;
  args.shift();
} else if (args[0] === "--app") {
  packaged = true;
  executable = args[1];
  if (executable === undefined) fail("--app needs a packaged test-profile executable");
  args.splice(0, 2);
}

// A user data directory named in the arguments is the caller's; otherwise a fresh one, removed afterwards.
const named = args.findIndex((arg) => arg.startsWith("--user-data-dir="));
const userDataDir = named >= 0 ? args.splice(named, 1)[0].slice("--user-data-dir=".length) : freshUserDataDir("start");
const removeUserData = named < 0;

let spec: ReturnType<typeof launchSpec>;
try {
  spec = launchSpec(packaged ? "packaged" : "unpackaged", "test", { executable, userDataDir });
  await checkLaunchInputs(spec);
} catch (err) {
  if (removeUserData) removeUserDataDir(userDataDir);
  fail(err);
}
process.stderr.write(`start: user data in ${userDataDir}${removeUserData ? " (removed on exit)" : ""}\n`);

const isWindows = process.platform === "win32";
const spawnedAt = Date.now();
const child = spawn(spec.command, [...spec.args, ...args], {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ["inherit", "pipe", "inherit"],
  // POSIX: its own session and process group, so signals to this launcher's group miss it.
  detached: !isWindows,
});
const monitor = monitorDesktopChild(child, spec, spawnedAt, {
  // Only launcher-created directories are unique ownership markers.
  userDataDir: removeUserData ? userDataDir : undefined,
  requireSmokeResult: process.env.DESKTOP_SMOKE === "1",
});
child.stdout.pipe(process.stdout);

const running = () => child.exitCode === null && child.signalCode === null;
const note = (message: string) => process.stderr.write(`start: ${message}\n`);
let received = 0;
let closed = false;
// Forward POSIX signals to the main process only so Chromium's GPU process is not killed mid-quit
// on Linux; the 2nd signal hits Electron's default action, and the 3rd SIGKILLs the process group.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (closed) return;
    received++;
    if (isWindows) {
      monitor.abort(new Error(`The test launch was interrupted by ${signal}`));
      return;
    }
    const pid = child.pid!;
    if (!running()) {
      // The main process has exited, but a process of its group still holds the output open.
      if (received >= 2) {
        note(`${signal} again: the app has exited but its process group ${pid} lingers: killing it with SIGKILL`);
        monitor.abort(new Error("The test launch was force-stopped"));
      } else {
        note(`${signal}: the app has exited; waiting for its helpers, a second signal kills them`);
      }
      return;
    }
    if (received >= 3) {
      note(`${signal} again: killing the app's process group ${pid} with SIGKILL`);
      monitor.abort(new Error("The test launch was force-stopped"));
      return;
    }
    if (received === 2)
      note(`${signal} again: passing it on; the app (pid ${pid}) has not quit, a third signal kills it`);
    try {
      process.kill(pid, signal);
    } catch {}
  });
}

// Never leave quietly while the app still runs (this launcher failing): say so, and ask the app to
// quit. Only a launcher killed outright (SIGKILL, or a signal it does not handle) cannot.
process.once("exit", () => {
  if (!running() || child.pid === undefined) return;
  note(`exiting while the app (pid ${child.pid}) still runs: sent it SIGTERM; its user data stays in ${userDataDir}`);
  // Its main process only, as for any signal: it takes its helpers with it.
  child.kill("SIGTERM");
});
try {
  const code = await monitor.finished;
  if (child.signalCode) note(`the app was ended by ${child.signalCode}`);
  process.exitCode = code ?? 1;
  if (code === 0 && readdirSync(userDataDir).length === 0)
    throw new Error(`The app left nothing in its user data directory ${userDataDir}`);
} catch (err) {
  note(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  closed = true;
  try {
    const killed = await monitor.reap();
    if (killed.length) note(`stopped lingering helpers: ${killed.join(", ")}`);
    if (removeUserData) removeUserDataDir(userDataDir);
  } catch (err) {
    note(`cleanup failed: ${String(err)}; user data kept in ${userDataDir}`);
    process.exitCode = 1;
  }
}
