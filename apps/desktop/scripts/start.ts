// `pnpm --filter desktop start`: the test build profile, the way the in-app smoke and manual checks
// run it, for example `DESKTOP_SMOKE=1 pnpm --filter desktop start`.
//
//   node scripts/start.ts [--packaged | --app <executable>] [electron arguments...]
//
// By default the unpackaged bundles (`electron .`, whose package.json `main` is
// `.vite/test/main.cjs`); `--packaged` starts the packaged test app in out/test
// (`pnpm package:desktop`), `--app` another packaged test-profile executable. Started the way
// scripts/launch.ts says: it first checks the target exists (unpackaged: that the bundles match the
// web build; packaged: that its fuses are the test profile's), then that the started main process
// reports the test build profile; otherwise it stops the app and exits 1. The app runs on a fresh
// user data directory, removed when it exits, unless the arguments name one
// (`--user-data-dir=<dir>`, kept). The app's environment, stdin, output and exit status pass through.
// Runs on Node directly (type stripping).
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

import { checkLaunchInputs, freshUserDataDir, launchSpec, removeUserDataDir, verifyBuildProfile } from "./launch.ts";

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

const child = spawn(spec.command, [...spec.args, ...args], {
  cwd: spec.cwd,
  env: { ...process.env, ...spec.env },
  stdio: ["inherit", "pipe", "inherit"],
});
let wrongBuild = false;
verifyBuildProfile(child.stdout, spec.profile).catch((err: unknown) => {
  wrongBuild = true;
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  child.kill("SIGKILL");
});
child.stdout.pipe(process.stdout);

// Ctrl+C reaches Electron through the terminal too; a plain `kill` of this script is passed on.
// Windows has no POSIX signals to forward (only termination), and SIGHUP there is the console closing.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    if (process.platform === "win32") child.kill();
    else child.kill(signal);
  });
}
child.once("error", (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = wrongBuild ? 1 : (code ?? (signal ? 1 : 0));
  // An app that ran and left nothing there did not run on it, and wrote somewhere else.
  let entries: string[] = [];
  try {
    entries = readdirSync(userDataDir);
  } catch {}
  if (!wrongBuild && code === 0 && entries.length === 0) {
    process.stderr.write(`The app left nothing in its user data directory ${userDataDir}\n`);
    process.exitCode = 1;
  }
  if (removeUserData) removeUserDataDir(userDataDir);
});
