import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyPreference,
  DESKTOP_PREFS_IPC,
  type DesktopPrefs,
  type PreferenceUpdateResult,
  sanitizePreferences,
} from "@repo/shared";
import { type IpcMainInvokeEvent, ipcMain } from "electron";

import type { Logger } from "./log.ts";

/** The preferences file in the user data directory. */
export const PREFS_FILE = "prefs.json";

/**
 * Preferences the main process injects into every request as `x-desktop-prefs`, so the server
 * renders the first frame with the user's theme or sidebar width. Read from `prefs.json` in the user
 * data directory; `{}` when absent or malformed, and invalid entries are dropped
 * (`sanitizePreferences`: the same key, value and size rules as writes).
 */
export function loadPrefs(userDataDir: string): DesktopPrefs {
  try {
    return sanitizePreferences(JSON.parse(readFileSync(join(userDataDir, PREFS_FILE), "utf8")));
  } catch {
    return {};
  }
}

/** The file operations a store persists with, and its wait between rename attempts; replaceable in tests. */
export interface PrefsFs {
  openSync(path: string, flags: "w"): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
  sleep(ms: number): void;
}

const nodeFs: PrefsFs = {
  openSync: (path, flags) => openSync(path, flags),
  writeFileSync: (fd, data) => writeFileSync(fd, data),
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
  // A synchronous wait: only between rename attempts, at most about 100 ms in all.
  sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
};

/**
 * Waits before each further rename attempt, about 100 ms in all. On Windows an antivirus scanner or
 * the search indexer can hold `prefs.json` open for a moment, failing the rename with one of
 * `RETRYABLE_RENAME`; other errors fail at once.
 */
const RENAME_RETRY_MS = [10, 20, 30, 40];
const RETRYABLE_RENAME = new Set(["EPERM", "EBUSY", "EACCES"]);

function renameWithRetry(fs: PrefsFs, from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
      const wait = RENAME_RETRY_MS[attempt];
      if (wait === undefined || typeof code !== "string" || !RETRYABLE_RENAME.has(code)) throw err;
      fs.sleep(wait);
    }
  }
}

/** Writes `data` to `path` and flushes it to the disk, so a rename over the old file never exposes an empty one. */
function writeDurably(fs: PrefsFs, path: string, data: string): void {
  const fd = fs.openSync(path, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface PrefsStore {
  /** The current preferences, frozen: what the next request's `x-desktop-prefs` carries. */
  current(): DesktopPrefs;
  /** Sets `key` (or removes it, for `null`) and persists; on any failure nothing changes. */
  update(key: unknown, value: unknown): PreferenceUpdateResult;
}

/**
 * The main process's preferences: loaded once, changed by `update()`, which validates, then writes
 * `prefs.json` atomically (a temporary file in the same directory, flushed with fsync, then a rename
 * over the old one, retried briefly while Windows holds the file) before the change takes effect. Synchronous: the file is at most a few KiB, and a write that
 * finished before `update()` returned cannot be lost by quitting right after.
 */
export function createPrefsStore(
  userDataDir: string,
  {
    log,
    initial = loadPrefs(userDataDir),
    fs = nodeFs,
  }: {
    log: Logger;
    initial?: DesktopPrefs;
    fs?: PrefsFs;
  },
): PrefsStore {
  let prefs = Object.freeze({ ...initial });
  const file = join(userDataDir, PREFS_FILE);
  const temp = `${file}.tmp`;
  return {
    current: () => prefs,
    update(key, value) {
      const applied = applyPreference(prefs, key, value);
      if (!applied.ok) return { status: "rejected", reason: applied.reason };
      try {
        writeDurably(fs, temp, `${JSON.stringify(applied.prefs, null, 2)}\n`);
        renameWithRetry(fs, temp, file);
      } catch (err) {
        try {
          fs.rmSync(temp, { force: true });
        } catch {
          // Nothing more to do: the next write replaces it.
        }
        // Never the key or value: preferences are user data (HOST-04).
        log.warn({ err }, "writing prefs.json failed");
        return { status: "rejected", reason: "persist-failed" };
      }
      prefs = Object.freeze(applied.prefs);
      return { status: "applied" };
    },
  };
}

/**
 * Handles `desktop:prefs:set` from the preload: `{ key, value }` from a trusted sender (the app
 * window's main frame on `app://app`) goes to `store.update()`. Returns the cleanup.
 */
export function installPrefsIpc(store: PrefsStore, trusted: (event: IpcMainInvokeEvent) => boolean): () => void {
  const set = (event: IpcMainInvokeEvent, input: unknown): PreferenceUpdateResult => {
    if (!trusted(event)) return { status: "rejected", reason: "untrusted-sender" };
    if (typeof input !== "object" || input === null || !("key" in input) || !("value" in input))
      return { status: "rejected", reason: "invalid-request" };
    return store.update(input.key, input.value);
  };
  ipcMain.handle(DESKTOP_PREFS_IPC.set, set);
  return () => ipcMain.removeHandler(DESKTOP_PREFS_IPC.set);
}
