import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DESKTOP_HEADERS, DESKTOP_PREFS_IPC, parseDesktopHeaders } from "@repo/shared";
import type { IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ipc, handlers } = vi.hoisted(() => {
  const registry = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers: registry,
    ipc: {
      handle: vi.fn<(channel: string, handler: (...args: unknown[]) => unknown) => unknown>((channel, handler) =>
        registry.set(channel, handler),
      ),
      removeHandler: vi.fn<(channel: string) => unknown>((channel) => registry.delete(channel)),
    },
  };
});
vi.mock("electron", () => ({ ipcMain: ipc }));

import { shapeRequestHeaders } from "./mapping.ts";
import { createPrefsStore, installPrefsIpc, loadPrefs, PREFS_FILE, type PrefsFs } from "./prefs.ts";

const log = {
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
};
let dir: string;
const file = () => join(dir, PREFS_FILE);
const onDisk = (): unknown => JSON.parse(readFileSync(file(), "utf8"));

/** A path relative to the test directory. */
const name = (path: string) => path.slice(dir.length + 1);

/** Real file operations under the test directory, recorded; `rename` replaces the rename. */
function recordingFs(rename: (from: string, to: string) => void = renameSync) {
  const calls: string[] = [];
  const fs: PrefsFs = {
    openSync: (path, flags) => {
      calls.push(`open ${name(path)}`);
      return openSync(path, flags);
    },
    writeFileSync: (fd, data) => {
      calls.push("write");
      writeFileSync(fd, data);
    },
    fsyncSync: (fd) => {
      calls.push("fsync");
      fsyncSync(fd);
    },
    closeSync: (fd) => {
      calls.push("close");
      closeSync(fd);
    },
    renameSync: (from, to) => {
      calls.push(`rename ${name(from)} ${name(to)}`);
      rename(from, to);
    },
    rmSync: (path, options) => rmSync(path, options),
    sleep: (ms) => calls.push(`sleep ${ms}`),
  };
  return { fs, calls };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "prefs-test-"));
  handlers.clear();
  vi.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("loadPrefs", () => {
  it("is empty without a file or with a malformed one", () => {
    expect(loadPrefs(dir)).toEqual({});
    for (const content of ["{", "null", "[1]", '"dark"', ""]) {
      writeFileSync(file(), content);
      expect(loadPrefs(dir)).toEqual({});
    }
  });

  it("keeps only valid entries", () => {
    writeFileSync(file(), JSON.stringify({ theme: "dark", "bad key": 1, nested: {}, width: 280, on: true }));
    expect(loadPrefs(dir)).toEqual({ theme: "dark", width: 280, on: true });
  });
});

describe("prefs store", () => {
  it("applies, persists and survives a reload from disk", () => {
    const store = createPrefsStore(dir, { log });
    expect(store.current()).toEqual({});
    expect(store.update("theme", "dark")).toEqual({ status: "applied" });
    expect(store.update("width", 280)).toEqual({ status: "applied" });
    expect(store.current()).toEqual({ theme: "dark", width: 280 });
    expect(Object.isFrozen(store.current())).toBe(true);
    expect(onDisk()).toEqual({ theme: "dark", width: 280 });
    expect(store.update("theme", null)).toEqual({ status: "applied" });
    expect(createPrefsStore(dir, { log }).current()).toEqual({ width: 280 });
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
  });

  it("rejects invalid input without touching memory or disk", () => {
    const store = createPrefsStore(dir, { log, initial: { theme: "dark" } });
    const before = store.current();
    expect(store.update("bad key", 1)).toEqual({ status: "rejected", reason: "invalid-key" });
    expect(store.update("theme", { x: 1 })).toEqual({ status: "rejected", reason: "invalid-value" });
    expect(store.update("theme", "x".repeat(5000))).toEqual({ status: "rejected", reason: "invalid-value" });
    expect(store.current()).toBe(before);
    expect(existsSync(file())).toBe(false);
  });

  it("bounds the total, so the header stays small", () => {
    const store = createPrefsStore(dir, { log });
    const results = Array.from({ length: 6 }, (_, i) => store.update(`key${i}`, "x".repeat(1000)).status);
    expect(results).toContain("rejected");
    expect(store.update("key5", "x".repeat(1000))).toEqual({ status: "rejected", reason: "too-large" });
  });

  it("writes a temporary file, flushes it to disk and renames it over prefs.json", () => {
    const { fs, calls } = recordingFs();
    createPrefsStore(dir, { log, fs }).update("theme", "dark");
    expect(calls).toEqual([
      `open ${PREFS_FILE}.tmp`,
      "write",
      "fsync",
      "close",
      `rename ${PREFS_FILE}.tmp ${PREFS_FILE}`,
    ]);
    expect(onDisk()).toEqual({ theme: "dark" });
  });

  it("retries a rename Windows refuses for a moment, then succeeds", () => {
    let refusals = 2;
    const { fs, calls } = recordingFs((from, to) => {
      if (refusals-- > 0) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      renameSync(from, to);
    });
    expect(createPrefsStore(dir, { log, fs }).update("theme", "dark")).toEqual({ status: "applied" });
    expect(calls.filter((call) => call.startsWith("sleep"))).toEqual(["sleep 10", "sleep 20"]);
    expect(onDisk()).toEqual({ theme: "dark" });
  });

  it("gives up after about 100 ms of refusals, and at once on other errors", () => {
    const busy = recordingFs(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    expect(createPrefsStore(dir, { log, fs: busy.fs }).update("theme", "dark")).toEqual({
      status: "rejected",
      reason: "persist-failed",
    });
    expect(busy.calls.filter((call) => call.startsWith("rename"))).toHaveLength(5);
    expect(busy.calls.filter((call) => call.startsWith("sleep"))).toEqual([
      "sleep 10",
      "sleep 20",
      "sleep 30",
      "sleep 40",
    ]);
    const full = recordingFs(() => {
      throw Object.assign(new Error("full"), { code: "ENOSPC" });
    });
    createPrefsStore(dir, { log, fs: full.fs }).update("theme", "dark");
    expect(full.calls.filter((call) => call.startsWith("rename"))).toHaveLength(1);
    expect(full.calls.some((call) => call.startsWith("sleep"))).toBe(false);
  });

  it("keeps the old file and the old values when the write fails, and logs no values", () => {
    writeFileSync(file(), JSON.stringify({ theme: "dark" }));
    const { fs } = recordingFs(() => {
      throw new Error("disk full");
    });
    const store = createPrefsStore(dir, { log, fs });
    expect(store.update("theme", "secret-light")).toEqual({ status: "rejected", reason: "persist-failed" });
    expect(store.current()).toEqual({ theme: "dark" });
    expect(onDisk()).toEqual({ theme: "dark" });
    expect(readdirSync(dir)).toEqual([PREFS_FILE]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("secret-light");
  });

  it("closes the temporary file and removes it when fsync fails", () => {
    const { fs, calls } = recordingFs();
    fs.fsyncSync = () => {
      throw new Error("io error");
    };
    expect(createPrefsStore(dir, { log, fs }).update("theme", "dark")).toMatchObject({ status: "rejected" });
    expect(calls).toContain("close");
    expect(calls.some((call) => call.startsWith("rename"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("feeds the next request's x-desktop-prefs header", () => {
    const store = createPrefsStore(dir, { log });
    const desktop = () => ({
      titlebar: "native" as const,
      chromeMode: "system-decorated" as const,
      fullscreen: false,
      prefs: store.current(),
    });
    const send = () =>
      parseDesktopHeaders(
        shapeRequestHeaders(new Headers({ [DESKTOP_HEADERS.prefs]: '{"forged":1}' }), {
          method: "GET",
          desktop: desktop(),
        }),
      ).prefs;
    expect(send()).toEqual({});
    store.update("locale", "\u4e2d\u6587");
    expect(send()).toEqual({ locale: "\u4e2d\u6587" });
  });
});

/** Stand-ins for `isTrustedSender()`: the handler gets a plain object, the check reads its flag. */
const event = (allowed: boolean) => ({ allowed });
const trusted = (input: IpcMainInvokeEvent) => "allowed" in input && input.allowed === true;
const invoke = (...args: unknown[]) => handlers.get(DESKTOP_PREFS_IPC.set)!(...args);

describe("prefs IPC", () => {
  it("updates only for trusted senders and well-formed requests", () => {
    const store = createPrefsStore(dir, { log });
    const dispose = installPrefsIpc(store, trusted);
    expect(invoke(event(false), { key: "theme", value: "dark" })).toEqual({
      status: "rejected",
      reason: "untrusted-sender",
    });
    expect(store.current()).toEqual({});
    for (const input of [null, "theme", { key: "theme" }, { value: 1 }])
      expect(invoke(event(true), input)).toEqual({ status: "rejected", reason: "invalid-request" });
    expect(invoke(event(true), { key: "theme", value: [1] })).toEqual({ status: "rejected", reason: "invalid-value" });
    expect(invoke(event(true), { key: "theme", value: "dark" })).toEqual({ status: "applied" });
    expect(store.current()).toEqual({ theme: "dark" });
    expect(invoke(event(true), { key: "theme", value: null })).toEqual({ status: "applied" });
    expect(store.current()).toEqual({});
    dispose();
    expect(handlers.has(DESKTOP_PREFS_IPC.set)).toBe(false);
  });
});
