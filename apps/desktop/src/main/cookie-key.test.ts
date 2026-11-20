import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { COOKIE_KEY_WRITER_FAILED_FILE, COOKIE_KEY_WRITER_SWITCH } from "~/startup-signals.ts";

import {
  checkCookieKeyProbe,
  COOKIE_KEY_FAILURE_TTL_MS,
  COOKIE_KEY_PROBE_PREFIX,
  COOKIE_KEY_PROBE_TEXT,
  COOKIE_KEY_READ_ATTEMPTS,
  COOKIE_KEY_READ_RETRY_MS,
  COOKIE_KEY_WRITER_CRASH_STATUS,
  COOKIE_KEY_WRITER_TIMEOUT_MS,
  cookieKeyProbeLine,
  type CookieKeySpawn,
  cookieKeyWriterArgs,
  cookieKeyWriterCrashHandler,
  hasStoredCookieKey,
  parseCookieKeyProbe,
  readCookieKeyState,
  storeCookieKeyFirst,
} from "./cookie-key.ts";

const USER_DATA = join("profiles", "Desktop");
const LOCAL_STATE = join(USER_DATA, "Local State");
const FAILED = join(USER_DATA, COOKIE_KEY_WRITER_FAILED_FILE);
const WITH_KEY = JSON.stringify({ os_crypt: { audit_enabled: true, encrypted_key: "RFBBUEkBAAAA" } });
const PROBE = Buffer.from("v10 encrypted probe").toString("base64");

/** An in-memory userData directory: path → content. */
function disk(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    read: vi.fn<(path: string) => string>((path) => {
      const content = files.get(path);
      if (content === undefined) throw Object.assign(new Error(`ENOENT ${path}`), { code: "ENOENT" });
      return content;
    }),
    write: vi.fn<(path: string, text: string) => void>((path, text) => {
      files.set(path, text);
    }),
    remove: vi.fn<(path: string) => void>((path) => {
      files.delete(path);
    }),
    sleep: vi.fn<(ms: number) => void>(),
  };
}

/** A read error other than "no such file": what a sharing violation looks like to Node. */
function busy(path: string): Error {
  return Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), { code: "EBUSY" });
}

const launch = {
  platform: "win32" as const,
  userData: USER_DATA,
  execPath: String.raw`C:\App\Desktop.exe`,
  appPath: undefined,
  appVersion: "1.2.3",
};
const NOW = new Date("2026-11-20T10:00:00.000Z");

it("waits for the writer at most 5 s", () => {
  expect(COOKIE_KEY_WRITER_TIMEOUT_MS).toBe(5000);
});

it.each([
  ["no file", undefined, false],
  ["not JSON", "{", false],
  ["no os_crypt", "{}", false],
  ["os_crypt without a key", JSON.stringify({ os_crypt: { audit_enabled: true } }), false],
  ["an empty key", JSON.stringify({ os_crypt: { encrypted_key: "" } }), false],
  ["a key", WITH_KEY, true],
])("hasStoredCookieKey: %s", (_name, content, expected) => {
  const { read } = disk(content === undefined ? {} : { [LOCAL_STATE]: content });
  expect(hasStoredCookieKey(USER_DATA, read)).toBe(expected);
});

it("tells a missing key from an unreadable Local State", () => {
  expect(readCookieKeyState(USER_DATA, disk().read)).toEqual({ state: "missing" });
  expect(readCookieKeyState(USER_DATA, disk({ [LOCAL_STATE]: "{}" }).read)).toEqual({ state: "missing" });
  expect(readCookieKeyState(USER_DATA, disk({ [LOCAL_STATE]: WITH_KEY }).read)).toEqual({ state: "stored" });
  expect(
    readCookieKeyState(USER_DATA, () => {
      throw busy(LOCAL_STATE);
    }),
  ).toEqual({ state: "unknown", reason: `EBUSY: resource busy or locked, open '${LOCAL_STATE}'` });
  // A partial write.
  expect(readCookieKeyState(USER_DATA, disk({ [LOCAL_STATE]: '{"os_crypt":{"encr' }).read)).toMatchObject({
    state: "unknown",
    reason: expect.stringContaining("Local State does not parse"),
  });
});

it("always gives the writer the resolved userData, no GPU and the switch, and nothing else", () => {
  expect(cookieKeyWriterArgs(launch)).toEqual([
    `--user-data-dir=${USER_DATA}`,
    "--disable-gpu",
    `--${COOKIE_KEY_WRITER_SWITCH}`,
  ]);
  // Unpackaged: the app directory comes first, as `electron <dir>` needs it.
  expect(cookieKeyWriterArgs({ ...launch, appPath: String.raw`C:\src\apps\desktop` })).toEqual([
    String.raw`C:\src\apps\desktop`,
    `--user-data-dir=${USER_DATA}`,
    "--disable-gpu",
    `--${COOKIE_KEY_WRITER_SWITCH}`,
  ]);
});

it("does nothing outside Windows, whatever userData holds", () => {
  const spawn = vi.fn<CookieKeySpawn>();
  const { read, write } = disk();
  for (const platform of ["darwin", "linux"] as const) {
    expect(storeCookieKeyFirst({ ...launch, platform }, { spawn, read, write })).toEqual({ kind: "none" });
  }
  expect(spawn).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it("does nothing when the key is stored but remove a failure record, without reading it", () => {
  const spawn = vi.fn<CookieKeySpawn>();
  const files = disk({ [LOCAL_STATE]: WITH_KEY, [FAILED]: "{}" });
  expect(storeCookieKeyFirst(launch, { spawn, ...files })).toEqual({ kind: "none" });
  expect(spawn).not.toHaveBeenCalled();
  expect(files.read.mock.calls).toEqual([[LOCAL_STATE]]);
  expect(files.files.has(FAILED)).toBe(false);
});

it("runs the writer on the same profile, waits for it and reports the stored key and its probe", () => {
  const files = disk();
  let t = 100;
  const spawn = vi.fn<CookieKeySpawn>(() => {
    files.files.set(LOCAL_STATE, WITH_KEY);
    t += 412.4;
    return { status: 0, stdout: `${COOKIE_KEY_PROBE_PREFIX}${PROBE}\r\n` };
  });
  const outcome = storeCookieKeyFirst(launch, { spawn, ...files, now: () => t });
  expect(spawn).toHaveBeenCalledWith(String.raw`C:\App\Desktop.exe`, cookieKeyWriterArgs(launch), {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "latin1",
    timeout: COOKIE_KEY_WRITER_TIMEOUT_MS,
  });
  expect(outcome).toEqual({ kind: "ran", ms: 412, key: "stored", status: 0, probe: PROBE });
  expect(files.write).not.toHaveBeenCalled();
  expect(files.sleep).not.toHaveBeenCalled();
});

it("records a writer run that did not store the key, then skips the writer while the key is missing", () => {
  const files = disk();
  const spawn = vi.fn<CookieKeySpawn>(() => ({
    status: null,
    error: new Error("spawnSync Desktop.exe ETIMEDOUT"),
    stdout: "",
  }));
  const deps = { spawn, ...files, now: () => 0, date: () => NOW };
  expect(storeCookieKeyFirst(launch, deps)).toEqual({
    kind: "ran",
    ms: 0,
    key: "missing",
    status: null,
    error: "Error: spawnSync Desktop.exe ETIMEDOUT",
  });
  expect(JSON.parse(files.files.get(FAILED) ?? "")).toEqual({
    failedAt: "2026-11-20T10:00:00.000Z",
    version: "1.2.3",
    status: null,
  });

  // Every later launch says it skipped, and when the run failed; none runs the writer again.
  for (let i = 0; i < 3; i++) {
    expect(storeCookieKeyFirst(launch, deps)).toEqual({ kind: "skipped", failedAt: "2026-11-20T10:00:00.000Z" });
  }
  expect(spawn).toHaveBeenCalledTimes(1);

  // Once the key is stored (the app's own clean quit writes it), the record is removed.
  files.files.set(LOCAL_STATE, WITH_KEY);
  expect(storeCookieKeyFirst(launch, deps)).toEqual({ kind: "none" });
  expect(files.files.has(FAILED)).toBe(false);
});

function failureRecord(failedAt: string, version = "1.2.3"): string {
  return JSON.stringify({ failedAt, version, status: 1 });
}

it("lets a failure record stop the writer only for the same version and for a day", () => {
  const ranWith = (content: string) => {
    const files = disk({ [FAILED]: content });
    const spawn = vi.fn<CookieKeySpawn>(() => ({ status: 1, stdout: null }));
    const outcome = storeCookieKeyFirst(launch, { spawn, ...files, date: () => NOW });
    return { ran: spawn.mock.calls.length === 1, outcome };
  };
  const justUnderADay = new Date(NOW.getTime() - COOKIE_KEY_FAILURE_TTL_MS + 1000).toISOString();
  expect(ranWith(failureRecord(justUnderADay))).toEqual({
    ran: false,
    outcome: { kind: "skipped", failedAt: justUnderADay },
  });
  // Another version, a day old or older, from the future, or without a version: the writer runs again.
  expect(ranWith(failureRecord(justUnderADay, "1.2.2")).ran).toBe(true);
  expect(ranWith(failureRecord(new Date(NOW.getTime() - COOKIE_KEY_FAILURE_TTL_MS).toISOString())).ran).toBe(true);
  expect(ranWith(failureRecord(new Date(NOW.getTime() + 60_000).toISOString())).ran).toBe(true);
  expect(ranWith(JSON.stringify({ failedAt: justUnderADay, status: 1 })).ran).toBe(true);
});

it("reads Local State again while it is unreadable right after the writer, and records nothing if it stays so", () => {
  // Held for two reads, then readable with the key: stored, after two short waits.
  const files = disk();
  let busyReads = 0;
  const spawn = vi.fn<CookieKeySpawn>(() => {
    files.files.set(LOCAL_STATE, WITH_KEY);
    busyReads = 2;
    return { status: 0, stdout: `${COOKIE_KEY_PROBE_PREFIX}${PROBE}\n` };
  });
  const read = (path: string) => {
    if (path === LOCAL_STATE && busyReads > 0) {
      busyReads--;
      throw busy(path);
    }
    return files.read(path);
  };
  expect(storeCookieKeyFirst(launch, { ...files, read, spawn, now: () => 0 })).toMatchObject({
    kind: "ran",
    key: "stored",
  });
  expect(files.sleep.mock.calls).toEqual([[COOKIE_KEY_READ_RETRY_MS], [COOKIE_KEY_READ_RETRY_MS]]);

  // Never readable (a sharing violation, or a partial write that never completes): unknown, no
  // failure record, and the next launch runs the writer again.
  for (const fault of ["busy", "partial"] as const) {
    const held = disk(fault === "partial" ? { [LOCAL_STATE]: '{"os_crypt":' } : {});
    const heldRead = (path: string) => {
      if (fault === "busy" && path === LOCAL_STATE) throw busy(path);
      return held.read(path);
    };
    const writer = vi.fn<CookieKeySpawn>(() => ({ status: 0, stdout: "" }));
    const deps = { ...held, read: heldRead, spawn: writer, now: () => 0, date: () => NOW };
    const outcome = storeCookieKeyFirst(launch, deps);
    expect(outcome).toMatchObject({ kind: "ran", key: "unknown", readError: expect.any(String) });
    expect(held.sleep).toHaveBeenCalledTimes(COOKIE_KEY_READ_ATTEMPTS - 1);
    expect(held.write).not.toHaveBeenCalled();
    storeCookieKeyFirst(launch, deps);
    expect(writer).toHaveBeenCalledTimes(2);
  }
});

it("runs the writer past an unreadable failure record, and on every launch when none can be written", () => {
  const unreadable = disk({ [FAILED]: "not json" });
  const spawn = vi.fn<CookieKeySpawn>(() => ({ status: 1, stdout: null }));
  storeCookieKeyFirst(launch, { spawn, ...unreadable });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(unreadable.files.get(FAILED)).toContain("failedAt");

  const readOnly = disk();
  readOnly.write.mockImplementation(() => {
    throw new Error("EACCES");
  });
  const again = vi.fn<CookieKeySpawn>(() => ({ status: 1, stdout: null }));
  for (let i = 0; i < 2; i++) {
    expect(storeCookieKeyFirst(launch, { spawn: again, ...readOnly })).toMatchObject({
      kind: "ran",
      key: "missing",
    });
  }
  expect(again).toHaveBeenCalledTimes(2);
});

it("prints the probe as one prefixed base64 line, and reads it back from the writer's stdout", () => {
  const encrypted = Uint8Array.from([0x76, 0x31, 0x30, 0, 255, 128, 7]);
  const line = cookieKeyProbeLine(encrypted);
  expect(line).toBe(`${COOKIE_KEY_PROBE_PREFIX}${Buffer.from(encrypted).toString("base64")}\n`);
  expect(parseCookieKeyProbe(line)).toBe(Buffer.from(encrypted).toString("base64"));
  // Whatever else is on stdout, only a well-formed prefixed line counts.
  expect(parseCookieKeyProbe(`noise\r\n${line.trimEnd()}\r\n`)).toBe(Buffer.from(encrypted).toString("base64"));
  expect(parseCookieKeyProbe("")).toBeUndefined();
  expect(parseCookieKeyProbe(`${COOKIE_KEY_PROBE_PREFIX}\n`)).toBeUndefined();
  expect(parseCookieKeyProbe(`${COOKIE_KEY_PROBE_PREFIX}not base64!\n`)).toBeUndefined();
  expect(parseCookieKeyProbe(`  ${line}`)).toBeUndefined();
});

it("passes the probe only when it decrypts back to the probe text", () => {
  const decrypt = vi.fn<(encrypted: Buffer) => string>(() => COOKIE_KEY_PROBE_TEXT);
  expect(checkCookieKeyProbe(PROBE, decrypt)).toEqual({ ok: true });
  expect(decrypt.mock.calls[0]?.[0].toString()).toBe("v10 encrypted probe");
  expect(checkCookieKeyProbe(PROBE, () => "something else")).toEqual({ ok: false, reason: "decrypted to other text" });
  expect(
    checkCookieKeyProbe(PROBE, () => {
      throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
    }),
  ).toEqual({ ok: false, reason: "Error while decrypting the ciphertext provided to safeStorage.decryptString." });
});

it("ends a key writer that hits an uncaught error with a non-zero status", () => {
  const exit = vi.fn<(code: number) => void>();
  const crash = cookieKeyWriterCrashHandler(exit);
  crash();
  expect(exit).toHaveBeenCalledWith(COOKIE_KEY_WRITER_CRASH_STATUS);
  expect(COOKIE_KEY_WRITER_CRASH_STATUS).not.toBe(0);
});
