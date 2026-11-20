// Launch the packaged release application using the caller's arguments and environment.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { dirname } from "node:path";

import { linuxSandboxBlocker, packagedBinary } from "./launch.ts";

// The foreground app handles terminal Ctrl+C itself.
function waitForChild() {}

export async function startRelease(args: string[]): Promise<number> {
  const executable = packagedBinary(undefined, "release");
  if (!existsSync(executable)) throw new Error(`${executable} is missing: run \`pnpm package:desktop\` first`);
  if (process.platform === "linux") {
    const blocker = linuxSandboxBlocker(executable);
    if (blocker) throw new Error(blocker);
  }

  const child = spawn(executable, args, { cwd: dirname(executable), stdio: "inherit" });
  // Terminal Ctrl+C reaches both processes in the foreground group.
  const forward = (signal: NodeJS.Signals) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const posix = process.platform !== "win32";
  if (posix) {
    process.on("SIGINT", waitForChild);
    process.on("SIGTERM", forward);
    process.on("SIGHUP", forward);
  }
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolve(code ?? (posix && signal ? 128 + constants.signals[signal] : 1));
      });
    });
  } finally {
    if (posix) {
      process.off("SIGINT", waitForChild);
      process.off("SIGTERM", forward);
      process.off("SIGHUP", forward);
    }
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await startRelease(process.argv.slice(2));
  } catch (error) {
    console.error("start:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
