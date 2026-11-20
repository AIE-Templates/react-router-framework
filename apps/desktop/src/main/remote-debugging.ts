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
 * endpoint only after the main script has run, and `app.exit()` this early ends the process on the
 * spot, so nothing ever listens and nothing else of the app starts.
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
  app.exit(REMOTE_DEBUGGING_EXIT_CODE);
}
