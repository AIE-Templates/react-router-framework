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
 * The `msg` of the main-process log line (level `info`, with the writer's duration as `ms`) printed
 * on Windows by a test or release launch whose profile had no cookie encryption key yet, once a
 * cookie key writer stored it (src/main/cookie-key.ts). Never printed on macOS or Linux, nor by a
 * launch that found the key.
 */
export const COOKIE_KEY_STORED_MESSAGE = "cookie key stored before start";

/**
 * After COOKIE_KEY_STORED_MESSAGE, once the main window is on its way, exactly one of: the `msg` of
 * an `info` line saying the launch runs on the key its writer stored (it decrypted the writer's
 * probe), or the `msg` of an `error` line, with `reason` and `risk` (what it costs: a packaged app's
 * persistent cookies, if it crashes in its first ~10 s), saying it does not.
 */
export const COOKIE_KEY_CHECKED_MESSAGE = "cookie key checked: this launch uses the stored key";
export const COOKIE_KEY_MISMATCH_MESSAGE = "this launch does not use the cookie key its key writer stored";

/**
 * The `msg`s of the main-process warnings (Windows, test and release builds) about a cookie key writer
 * run that did not end with the key stored and checked (src/main.ts): Local State has no key after it;
 * Local State could not be read after it (nothing recorded); it was skipped after a recent failed run;
 * it printed no probe, so the launch cannot check its key. Each carries what it costs as `risk` where
 * that applies.
 */
export const COOKIE_KEY_NOT_STORED_MESSAGE = "the cookie key writer did not store the cookie key";
export const COOKIE_KEY_UNKNOWN_MESSAGE = "could not tell whether the cookie key writer stored the cookie key";
export const COOKIE_KEY_SKIPPED_MESSAGE = "cookie key writer skipped: a run of this version failed within a day";
export const COOKIE_KEY_NO_PROBE_MESSAGE = "the cookie key writer printed no probe; the key in use is not checked";
/**
 * The file a cookie key writer run that left no key behind writes into userData, so later launches of
 * the same version skip the writer for a while (src/main/cookie-key.ts). A launch on a fresh profile
 * whose writer worked never has one.
 */
export const COOKIE_KEY_WRITER_FAILED_FILE = "cookie-key-writer-failed.json";

export const COOKIE_KEY_WRITER_WARNINGS = [
  COOKIE_KEY_NOT_STORED_MESSAGE,
  COOKIE_KEY_UNKNOWN_MESSAGE,
  COOKIE_KEY_SKIPPED_MESSAGE,
  COOKIE_KEY_NO_PROBE_MESSAGE,
] as const;

/**
 * The switch, without its `--` prefix, that makes a test or release launch on Windows a cookie key
 * writer: a short-lived copy of the app that only lets Chromium store the profile's cookie key and
 * quits (src/main/cookie-key.ts).
 */
export const COOKIE_KEY_WRITER_SWITCH = "desktop-cookie-key-writer";

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
