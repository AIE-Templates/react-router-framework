import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";

/** The file operations a store persists with, and its wait between rename attempts; replaceable in tests. */
export interface AtomicFileFs {
  openSync(path: string, flags: "w"): number;
  writeFileSync(fd: number, data: string): void;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  rmSync(path: string, options: { force: true }): void;
  sleep(ms: number): void;
}

export const nodeFs: AtomicFileFs = {
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

export function renameWithRetry(fs: AtomicFileFs, from: string, to: string): void {
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
export function writeDurably(fs: AtomicFileFs, path: string, data: string): void {
  const fd = fs.openSync(path, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
