// `pnpm --filter desktop start`: the built test profile, unpackaged (`electron .`, whose package.json
// `main` is `.vite/test/main.cjs`), the way the in-app smoke and manual checks run it, for example
// `DESKTOP_SMOKE=1 pnpm --filter desktop start`. Like every launcher (scripts/launch.ts) it first
// checks that the bundles exist and match the web build, then that the started main process reports
// the test build profile; otherwise it stops the app and exits 1. The app's environment, stdin,
// output and exit status pass through; extra arguments go to Electron. Runs on Node directly.
import { spawn } from "node:child_process";

import { checkUnpackagedBuild, desktopDir, electronBinary, verifyBuildProfile } from "./launch.ts";

try {
  checkUnpackagedBuild("test");
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

const child = spawn(electronBinary(), [".", ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: ["inherit", "pipe", "inherit"],
});
let wrongBuild = false;
verifyBuildProfile(child.stdout, "test").catch((err: unknown) => {
  wrongBuild = true;
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  child.kill("SIGKILL");
});
child.stdout.pipe(process.stdout);

// Ctrl+C reaches Electron through the terminal too; a plain `kill` of this script is passed on.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.once("error", (err) => {
  process.stderr.write(`${err.message}\n`);
  process.exitCode = 1;
});
child.once("close", (code, signal) => {
  process.exitCode = wrongBuild ? 1 : (code ?? (signal ? 1 : 0));
});
