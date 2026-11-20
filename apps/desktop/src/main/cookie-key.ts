import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { COOKIE_KEY_WRITER_SWITCH } from "~/startup-signals.ts";

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
 * Cost: one extra start and quit of the app on a profile's first launch, measured at 100 to 130 ms
 * (once 313 ms) on that VM, which delays its main window by about as much; one small file read on
 * every later launch.
 *
 * What the copy gets: `--user-data-dir` with the userData path this launch resolved, always, so both
 * use the same directory however this launch's was chosen (`Local State` lives in Chromium's user data
 * directory, which is the userData path); `--disable-gpu`, as it draws nothing; and the switch. Nothing
 * else: Windows has one key store (DPAPI, per user account) and no switch that picks another
 * (`--password-store` and `--use-mock-keychain` are Linux and macOS switches), Chromium's sandbox needs
 * no switch there, and remote debugging switches in particular are never passed on.
 */

/** How long a launch waits for its key writer before starting anyway. */
export const COOKIE_KEY_WRITER_TIMEOUT_MS = 10_000;

/**
 * Left in userData after a writer run that did not store the key, so a profile whose key cannot be
 * stored (DPAPI failing, say) does not pay for a writer run on every launch: the next launches skip
 * the writer and say so. A launch that finds the key never looks at it.
 */
export const COOKIE_KEY_WRITER_FAILED_FILE = "cookie-key-writer-failed.json";

/** What the key writer encrypts for the launch that started it to decrypt. */
export const COOKIE_KEY_PROBE_TEXT = "cookie key probe";

/** The start of the key writer's one stdout line, followed by the base64 of the encrypted probe. */
export const COOKIE_KEY_PROBE_PREFIX = "COOKIE_KEY_PROBE ";

/** Whether `<userData>/Local State` holds a cookie encryption key. Never throws. */
export function hasStoredCookieKey(userData: string, read: (path: string) => string = readText): boolean {
  try {
    const state: unknown = JSON.parse(read(join(userData, "Local State")));
    const osCrypt = typeof state === "object" && state !== null && "os_crypt" in state ? state.os_crypt : undefined;
    const key =
      typeof osCrypt === "object" && osCrypt !== null && "encrypted_key" in osCrypt ? osCrypt.encrypted_key : undefined;
    return typeof key === "string" && key !== "";
  } catch {
    return false;
  }
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function writeText(path: string, text: string): void {
  writeFileSync(path, text);
}

export interface CookieKeyLaunch {
  platform: NodeJS.Platform;
  /** The userData path this launch resolved, which is where Chromium keeps `Local State`. */
  userData: string;
  /** `process.execPath`. */
  execPath: string;
  /** Unpackaged (`electron <dir>`): the app directory, which the copy needs as its first argument. */
  appPath: string | undefined;
}

export type CookieKeyOutcome =
  /** Not Windows, or the key is stored: nothing to do. */
  | { kind: "none" }
  /** An earlier writer run on this profile failed and the key is still not stored: not run again. */
  | { kind: "skipped"; failedAt: string }
  | {
      kind: "ran";
      ms: number;
      stored: boolean;
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
 * throws: whatever happens, the app starts. A run that did not store the key leaves
 * COOKIE_KEY_WRITER_FAILED_FILE, and later launches skip the writer while the key is missing.
 */
export function storeCookieKeyFirst(
  launch: CookieKeyLaunch,
  {
    spawn = spawnWriter,
    read = readText,
    write = writeText,
    now = () => performance.now(),
    date = () => new Date(),
    timeoutMs = COOKIE_KEY_WRITER_TIMEOUT_MS,
  }: {
    spawn?: CookieKeySpawn;
    read?: (path: string) => string;
    write?: (path: string, text: string) => void;
    now?: () => number;
    date?: () => Date;
    timeoutMs?: number;
  } = {},
): CookieKeyOutcome {
  const { platform, userData, execPath } = launch;
  if (platform !== "win32" || hasStoredCookieKey(userData, read)) return { kind: "none" };
  const failedFile = join(userData, COOKIE_KEY_WRITER_FAILED_FILE);
  const failedAt = previousFailure(failedFile, read);
  if (failedAt !== undefined) return { kind: "skipped", failedAt };

  const start = now();
  const result = spawn(execPath, cookieKeyWriterArgs(launch), {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "latin1",
    // Not `windowsHide`: the copy opens no window, and on Windows that option makes the first window a
    // process shows start hidden, which only makes sense for console programs.
    timeout: timeoutMs,
  });
  const probe = parseCookieKeyProbe(result.stdout ?? "");
  const outcome: CookieKeyOutcome = {
    kind: "ran",
    ms: Math.round(now() - start),
    stored: hasStoredCookieKey(userData, read),
    status: result.status,
    ...(result.error ? { error: String(result.error) } : {}),
    ...(probe === undefined ? {} : { probe }),
  };
  if (!outcome.stored) {
    try {
      write(failedFile, JSON.stringify({ failedAt: date().toISOString(), status: outcome.status }) + "\n");
    } catch {
      // Not recorded: the next launch tries again, and says so again.
    }
  }
  return outcome;
}

function previousFailure(path: string, read: (path: string) => string): string | undefined {
  try {
    const record: unknown = JSON.parse(read(path));
    const at = typeof record === "object" && record !== null && "failedAt" in record ? record.failedAt : undefined;
    return typeof at === "string" ? at : "an earlier launch";
  } catch {
    return undefined;
  }
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
