import { writeSync } from "node:fs";

import { app } from "electron";

import {
  REMOTE_DEBUGGING_EXIT_CODE,
  REMOTE_DEBUGGING_REFUSED_MESSAGE,
  remoteDebuggingSwitch,
} from "~/startup-signals.ts";

import { createLogger } from "./log.ts";

/**
 * Release builds only, as the first thing the main entry does: a process started with a Chromium
 * remote debugging switch (`--remote-debugging-port`, `--remote-debugging-pipe`) prints one log line
 * and exits with a status of its own, both from ~/startup-signals.ts. Chromium opens the debugging
 * endpoint only after the main script has run, so nothing ever listens and nothing else of the app
 * starts. Returns only for a launch without such a switch.
 */
export function refuseRemoteDebugging(): void {
  const found = remoteDebuggingSwitch((name) => app.commandLine.hasSwitch(name), process.argv, process.platform);
  if (found === undefined) return;
  // Written synchronously, since the process is gone before a stream could flush; a closed stdout
  // must not keep it alive either.
  const log = createLogger("info", (line) => {
    try {
      writeSync(1, line);
    } catch {}
  });
  log.error({ switch: found }, REMOTE_DEBUGGING_REFUSED_MESSAGE);
  exitNow(REMOTE_DEBUGGING_EXIT_CODE);
}

/**
 * Ends the process with `code` without ever returning, so the rest of the main entry cannot run.
 * `app.exit()` this early, before Electron's message loop exists, ends the process on the spot; the
 * steps after it are for an Electron that would defer it instead (`process.exit` is no such step: in
 * the main process it is `app.exit` again).
 */
function exitNow(code: number): never {
  app.exit(code);
  // Node's own exit, which `process.exit` ends in everywhere else: the C library's, at once.
  const reallyExit: unknown = Reflect.get(process, "reallyExit");
  if (typeof reallyExit === "function") Reflect.apply(reallyExit, process, [code]);
  // Still here: the status is lost, but nothing of the app may start.
  process.kill(process.pid, "SIGKILL");
  throw new Error("The process survived its own exit");
}
