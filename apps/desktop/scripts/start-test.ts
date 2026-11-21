// `pnpm --dir apps/desktop start:test`: the test build profile, the way the in-app smoke and manual checks
// run it, for example `DESKTOP_SMOKE=1 pnpm --dir apps/desktop start:test`.
//
//   node scripts/start-test.ts [--packaged | --app <executable>] [electron arguments...]
//
// By default the unpackaged bundles (`electron .`, whose package.json `main` is
// `.vite/test/main.cjs`); `--packaged` starts the packaged test app in out/test
// (`pnpm package:desktop:test`), `--app` another packaged test-profile executable. Started the way
// scripts/launch.ts says: it first checks the target exists (unpackaged: that the bundles match the
// web build; packaged: that its fuses are the test profile's), then that the started main process
// reports the test build profile; otherwise it stops the app and exits 1. The app runs on a fresh
// user data directory, removed when it exits, unless the arguments name one
// (`--user-data-dir=<dir>`, kept). The app's environment, stdin, output and exit status pass through.
//
// Signals (POSIX): the app runs in its own session and process group (as scripts/verify-release.ts
// starts it), so a signal meant for this launcher (Ctrl+C, which the terminal sends to its foreground
// process group, `kill -- -<pgid>`, or `kill <pid>`) never reaches the app's helper processes
// directly. Killed with them, Chromium's GPU process dies under a main process that is still quitting,
// and on Linux it then aborts ("GPU process isn't usable. Goodbye.", measured 30 of 30 runs). And
// Electron answers only the first SIGINT or SIGTERM with its own quit and then restores the default
// action, so the same signal arriving twice at once (the group's and a forwarded copy) cut that quit
// short. Instead every SIGINT, SIGTERM and SIGHUP this launcher receives is passed on at once to the
// app's main process alone, which then quits the way it does when asked (measured: exit 0 with every
// process gone). A second signal while the app still runs is passed on too, on purpose: by then the
// default action ends an app that did not quit. A third kills the app's whole process group with
// SIGKILL, which also ends one that is stopped; so does a second one once the main process has exited
// while a helper still holds its output open. The app has no controlling terminal; it reads no input
// (stdin stays shared all the same). Windows has no such signals: each one terminates the app.
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
