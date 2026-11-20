// What the main process tells whoever started it, shared with the scripts that start it and read its
// output and exit status. Dependency-free and erasable TypeScript with no `~/` imports: plain Node
// imports this file from scripts/ as well.

/** The Chromium switches that open a remote debugging endpoint, without their `--` prefix. */
export const REMOTE_DEBUGGING_SWITCHES = ["remote-debugging-port", "remote-debugging-pipe"] as const;
export type RemoteDebuggingSwitch = (typeof REMOTE_DEBUGGING_SWITCHES)[number];

/**
 * The exit status of a release build started with one of REMOTE_DEBUGGING_SWITCHES, and of nothing
 * else: outside Node's own codes (1 to 14), Chromium's result codes, sysexits (64 to 78) and the
 * shell's (126 and up).
 */
export const REMOTE_DEBUGGING_EXIT_CODE = 97;

/**
 * The `msg` of the one main-process log line (level `error`, with the switch as `switch`) a release
 * build prints before it exits with REMOTE_DEBUGGING_EXIT_CODE.
 */
export const REMOTE_DEBUGGING_REFUSED_MESSAGE = "remote debugging refused";

/**
 * The `msg` of the main-process log line (level `info`, so LOG_LEVEL cannot suppress it) printed once
 * per process, in every build profile, when the main window both holds a successfully loaded
 * document and is visible. Never printed for a failed load or a hidden window.
 */
export const MAIN_WINDOW_READY_MESSAGE = "main window loaded and shown";

/**
 * The remote debugging switch a process was started with, if any. `hasSwitch` is Chromium's own view
 * of the command line (Electron's `app.commandLine.hasSwitch`); `argv` is checked as well, in every
 * spelling Chromium accepts (`--name`, `--name=value`, a single `-`, and on Windows `/name` and any
 * letter case), and past a `--` terminator too: refusing one launch too many is the safe side.
 */
export function remoteDebuggingSwitch(
  hasSwitch: (name: RemoteDebuggingSwitch) => boolean,
  argv: readonly string[],
  platform: string,
): RemoteDebuggingSwitch | undefined {
  const windows = platform === "win32";
  for (const name of REMOTE_DEBUGGING_SWITCHES) {
    if (hasSwitch(name)) return name;
    for (const raw of argv) {
      const arg = windows ? raw.toLowerCase() : raw;
      const prefix = arg.startsWith("--") ? 2 : arg.startsWith("-") || (windows && arg.startsWith("/")) ? 1 : 0;
      if (prefix === 0) continue;
      const end = arg.indexOf("=");
      if (arg.slice(prefix, end < 0 ? undefined : end) === name) return name;
    }
  }
  return undefined;
}
