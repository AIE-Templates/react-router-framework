import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COOKIE_KEY_WRITER_FAILED_FILE, COOKIE_KEY_WRITER_SWITCH } from "~/startup-signals.ts";

/**
 * Windows: puts the cookie encryption key on the disk before a profile's first launch starts, so a
 * persistent cookie survives a crash or a kill from its first response on (HOST-09).
 *
 * With the `EnableCookieEncryption` fuse, Chromium encrypts every cookie value at rest with a key it
 * makes at startup when the profile has none (`safeStorage` uses the same key). On Windows the only
 * copy of that key on disk is `os_crypt.encrypted_key` (DPAPI-wrapped) in `<userData>/Local State`, a
 * file Chromium writes about 10 s after a change or at a clean quit, never sooner. A first launch
 * that dies before then leaves cookie rows nobody can decrypt: the next launch makes a new key, drops
 * those rows and sends no cookie. Flushing the cookie store does not help (the rows are on disk), and
 * Electron has no API that writes `Local State` early. (Measured on Electron 45, Windows 11 arm64: a
 * kill up to 8.6 s after the start lost the cookie, from 10.6 s on it survived. macOS and Linux keep
 * the key in the keychain or keyring, or use a fixed one, and need none of this.)
 * Tracking issue: https://github.com/electron/electron/issues/55978 (open). Once Electron writes the
 * key to disk when it makes it, this whole module and its call sites can go.
 *
 * So a launch whose `Local State` has no key, once it holds the single-instance lock, runs a copy of
 * the app on the same profile with COOKIE_KEY_WRITER_SWITCH and waits for it: Chromium makes the key,
 * the copy quits at `ready`, and the clean quit writes `Local State`. The launch itself reads `Local
 * State` only after its main script's synchronous part, so it starts on that key. That order is
 * measured behaviour, not documented, so it is checked at runtime: the copy encrypts
 * COOKIE_KEY_PROBE_TEXT with `safeStorage` at `ready` and prints it (COOKIE_KEY_PROBE_PREFIX), and the
 * launch, once ready, must decrypt it back (`checkCookieKeyProbe`): it logs
 * COOKIE_KEY_CHECKED_MESSAGE, or COOKIE_KEY_MISMATCH_MESSAGE as an error (~/startup-signals.ts).
 * (Measured: with Local State removed between the copy's exit and the launch's start, the launch
 * logs the mismatch; swapping Local State loses `safeStorage` data and cookies alike.)
 * Cost: one extra start and quit of the app on a profile's first launch, measured at 98 to 171 ms
 * typically on that VM (occasionally about 310 ms), which delays its main window by about as much and
 * is noted in the boot profile as `cookie-key-writer-ms`; one small file read on every later launch.
 *
 * The probe uses `safeStorage`'s synchronous API (`isEncryptionAvailable`, `encryptString`,
 * `decryptString`), which Electron 45 marks deprecated in favour of the asynchronous one and which
 * prints deprecation warnings on stderr. It stays for now because the probe must use the very key that
 * cookie encryption uses, and that was measured for the synchronous API only (the asynchronous
 * encryptor is a separate, lazily created one). Should the synchronous methods disappear, the writer
 * prints no probe (its call throws inside a `try`) and the launch logs that it could not check the
 * key, a warning: the key is still stored, only no longer checked.
 *
 * What the copy gets: `--user-data-dir` with the userData path this launch resolved, always, so both
 * use the same directory however this launch's was chosen (`Local State` lives in Chromium's user data
 * directory, which is the userData path); `--disable-gpu`, as it draws nothing; and the switch. Nothing
 * else: Windows has one key store (DPAPI, per user account) and no switch that picks another
 * (`--password-store` and `--use-mock-keychain` are Linux and macOS switches), Chromium's sandbox needs
 * no switch there, and remote debugging switches in particular are never passed on.
 */

/**
 * How long a launch waits for its key writer before starting anyway. The wait holds the
 * single-instance lock, so a second launch started meanwhile waits too; the writer takes 98 to 171 ms
 * typically (occasionally about 310 ms; measured on Windows 11 arm64, see above).
 */
export const COOKIE_KEY_WRITER_TIMEOUT_MS = 5_000;

// COOKIE_KEY_WRITER_FAILED_FILE (~/startup-signals.ts) is left in userData after a writer run that, as
// far as could be told, did not store the key, so a profile whose key cannot be stored (DPAPI failing,
// say) does not pay for a writer run on every launch: the next launches of the same app version skip
// the writer and say so, for COOKIE_KEY_FAILURE_TTL_MS. It is removed as soon as a launch finds the key.

/** How long a failure record stops the writer: after that, or with another app version, it runs again. */
export const COOKIE_KEY_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Right after the writer exits, `Local State` may still be held or half written: an unreadable or
 * unparseable file is read again this many times, this far apart, before the outcome is "unknown".
 */
export const COOKIE_KEY_READ_ATTEMPTS = 5;
export const COOKIE_KEY_READ_RETRY_MS = 50;

/** The exit status of a key writer that hit an uncaught exception or an unhandled rejection. */
export const COOKIE_KEY_WRITER_CRASH_STATUS = 1;

/** What the key writer encrypts for the launch that started it to decrypt. */
export const COOKIE_KEY_PROBE_TEXT = "cookie key probe";

/** The start of the key writer's one stdout line, followed by the base64 of the encrypted probe. */
export const COOKIE_KEY_PROBE_PREFIX = "COOKIE_KEY_PROBE ";

/**
 * What `<userData>/Local State` says about the cookie key: `stored`; `missing`, only when the file
 * does not exist or is read and parsed and holds no key; otherwise `unknown`, with why (any other read
 * error, such as a sharing violation, or a file that does not parse, such as a partial write). Never
 * throws.
 */
export type CookieKeyState = { state: "stored" } | { state: "missing" } | { state: "unknown"; reason: string };

export function readCookieKeyState(userData: string, read: (path: string) => string = readText): CookieKeyState {
  let text: string;
  try {
    text = read(join(userData, "Local State"));
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { state: "missing" };
    return { state: "unknown", reason: describeError(err) };
  }
  let state: unknown;
  try {
    state = JSON.parse(text);
  } catch (err) {
    return { state: "unknown", reason: `Local State does not parse: ${describeError(err)}` };
  }
  const osCrypt = typeof state === "object" && state !== null && "os_crypt" in state ? state.os_crypt : undefined;
  const key =
    typeof osCrypt === "object" && osCrypt !== null && "encrypted_key" in osCrypt ? osCrypt.encrypted_key : undefined;
  return typeof key === "string" && key !== "" ? { state: "stored" } : { state: "missing" };
}

/** Whether `<userData>/Local State` holds a cookie encryption key. Never throws. */
export function hasStoredCookieKey(userData: string, read: (path: string) => string = readText): boolean {
  return readCookieKeyState(userData, read).state === "stored";
}

function errorCode(err: unknown): unknown {
  return typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}

function removeFile(path: string): void {
  rmSync(path, { force: true });
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface CookieKeyLaunch {
  platform: NodeJS.Platform;
  /** The userData path this launch resolved, which is where Chromium keeps `Local State`. */
  userData: string;
  /** `process.execPath`. */
  execPath: string;
  /** Unpackaged (`electron <dir>`): the app directory, which the copy needs as its first argument. */
  appPath: string | undefined;
  /** `app.getVersion()`: a failure record of another version is ignored. */
  appVersion: string;
}

export type CookieKeyOutcome =
  /** Not Windows, or the key is stored: nothing to do. */
  | { kind: "none" }
  /**
   * A writer run of this app version on this profile failed less than COOKIE_KEY_FAILURE_TTL_MS ago
   * and the key is still not stored: not run again.
   */
  | { kind: "skipped"; failedAt: string }
  | {
      kind: "ran";
      /** The writer's wall time, start to exit. */
      ms: number;
      /** What Local State said once the writer had exited (read again a few times while unknown). */
      key: "stored" | "missing" | "unknown";
      /** Why the key's state is unknown. */
      readError?: string;
      status: number | null;
      error?: string;
      /** The base64 of the writer's encrypted probe, if it printed one. */
      probe?: string;
    };

/** The part of `spawnSync` the key writer needs, so tests can pass a fake. */
export type CookieKeySpawn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "ignore"]; encoding: "latin1"; timeout: number },
) => { status: number | null; error?: Error; stdout: string | null };

const spawnWriter: CookieKeySpawn = (command, args, options) => spawnSync(command, args, options);

/** The copy's command line: the app directory when unpackaged, the profile, no GPU, the switch. */
export function cookieKeyWriterArgs({ userData, appPath }: Pick<CookieKeyLaunch, "userData" | "appPath">): string[] {
  return [
    ...(appPath === undefined ? [] : [appPath]),
    `--user-data-dir=${userData}`,
    "--disable-gpu",
    `--${COOKIE_KEY_WRITER_SWITCH}`,
  ];
}

/**
 * On Windows, when `Local State` has no cookie key yet, runs the key writer and waits for it (at most
 * `timeoutMs`). Call it holding the single-instance lock, so two launches never both run one. Never
 * throws: whatever happens, the app starts. A run after which Local State has no key leaves
 * COOKIE_KEY_WRITER_FAILED_FILE, and later launches of the same version skip the writer for a while;
 * a run after which Local State cannot be read leaves nothing, so the next launch checks again. A
 * launch that finds the key removes the record.
 */
export function storeCookieKeyFirst(
  launch: CookieKeyLaunch,
  {
    spawn = spawnWriter,
    read = readText,
    write = writeText,
    remove = removeFile,
    sleep = sleepSync,
    now = () => performance.now(),
    date = () => new Date(),
    timeoutMs = COOKIE_KEY_WRITER_TIMEOUT_MS,
  }: {
    spawn?: CookieKeySpawn;
    read?: (path: string) => string;
    write?: (path: string, text: string) => void;
    remove?: (path: string) => void;
    sleep?: (ms: number) => void;
    now?: () => number;
    date?: () => Date;
    timeoutMs?: number;
  } = {},
): CookieKeyOutcome {
  const { platform, userData, execPath, appVersion } = launch;
  if (platform !== "win32") return { kind: "none" };
  const failedFile = join(userData, COOKIE_KEY_WRITER_FAILED_FILE);
  const forget = () => {
    try {
      remove(failedFile);
    } catch {
      // Left there: it is ignored once it is a day old or the version changes.
    }
  };
  if (hasStoredCookieKey(userData, read)) {
    forget();
    return { kind: "none" };
  }
  const failedAt = previousFailure(failedFile, read, appVersion, date());
  if (failedAt !== undefined) return { kind: "skipped", failedAt };

  const start = now();
  const result = spawn(execPath, cookieKeyWriterArgs(launch), {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "latin1",
    // Not `windowsHide`: the copy opens no window, and on Windows that option makes the first window a
    // process shows start hidden, which only makes sense for console programs.
    timeout: timeoutMs,
  });
  const ms = Math.round(now() - start);
  let key = readCookieKeyState(userData, read);
  for (let attempt = 1; key.state === "unknown" && attempt < COOKIE_KEY_READ_ATTEMPTS; attempt++) {
    sleep(COOKIE_KEY_READ_RETRY_MS);
    key = readCookieKeyState(userData, read);
  }
  const probe = parseCookieKeyProbe(result.stdout ?? "");
  const outcome: CookieKeyOutcome = {
    kind: "ran",
    ms,
    key: key.state,
    ...(key.state === "unknown" ? { readError: key.reason } : {}),
    status: result.status,
    ...(result.error ? { error: String(result.error) } : {}),
    ...(probe === undefined ? {} : { probe }),
  };
  if (key.state === "stored") {
    forget();
  } else if (key.state === "missing") {
    try {
      write(
        failedFile,
        JSON.stringify({ failedAt: date().toISOString(), version: appVersion, status: outcome.status }) + "\n",
      );
    } catch {
      // Not recorded: the next launch tries again, and says so again.
    }
  }
  return outcome;
}

/**
 * When a failure record holds: one of this app version, from the last COOKIE_KEY_FAILURE_TTL_MS. An
 * unreadable, malformed, foreign, stale or future-dated record does not.
 */
function previousFailure(path: string, read: (path: string) => string, version: string, now: Date): string | undefined {
  let record: unknown;
  try {
    record = JSON.parse(read(path));
  } catch {
    return undefined;
  }
  if (typeof record !== "object" || record === null) return undefined;
  const at = "failedAt" in record ? record.failedAt : undefined;
  const recordVersion = "version" in record ? record.version : undefined;
  if (typeof at !== "string" || recordVersion !== version) return undefined;
  const age = now.getTime() - Date.parse(at);
  return age >= 0 && age < COOKIE_KEY_FAILURE_TTL_MS ? at : undefined;
}

/**
 * The key writer's handler for an uncaught exception or an unhandled rejection: it ends the process
 * with COOKIE_KEY_WRITER_CRASH_STATUS at once, so Electron never shows its blocking error dialog (which
 * would hold the launch waiting for the writer until its timeout).
 */
export function cookieKeyWriterCrashHandler(exit: (code: number) => void): () => void {
  return () => exit(COOKIE_KEY_WRITER_CRASH_STATUS);
}

/** The key writer's stdout line for `encrypted`, the probe as `safeStorage` encrypted it. */
export function cookieKeyProbeLine(encrypted: Uint8Array): string {
  return `${COOKIE_KEY_PROBE_PREFIX}${Buffer.from(encrypted).toString("base64")}\n`;
}

/** The base64 probe on the key writer's stdout, if one line carries a well-formed one. */
export function parseCookieKeyProbe(stdout: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    if (!raw.startsWith(COOKIE_KEY_PROBE_PREFIX)) continue;
    const value = raw.slice(COOKIE_KEY_PROBE_PREFIX.length).trim();
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return value;
  }
  return undefined;
}

/**
 * Whether this process decrypts the key writer's probe back to COOKIE_KEY_PROBE_TEXT, that is, runs
 * on the key the writer stored. `decrypt` is `safeStorage.decryptString`; a throw counts as a failure.
 */
export function checkCookieKeyProbe(
  probe: string,
  decrypt: (encrypted: Buffer) => string,
): { ok: true } | { ok: false; reason: string } {
  try {
    const text = decrypt(Buffer.from(probe, "base64"));
    return text === COOKIE_KEY_PROBE_TEXT ? { ok: true } : { ok: false, reason: "decrypted to other text" };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
