import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { COOKIE_KEY_WRITER_SWITCH } from "~/startup-signals.ts";

import {
  checkCookieKeyProbe,
  COOKIE_KEY_PROBE_PREFIX,
  COOKIE_KEY_PROBE_TEXT,
  COOKIE_KEY_WRITER_FAILED_FILE,
  cookieKeyProbeLine,
  type CookieKeySpawn,
  cookieKeyWriterArgs,
  hasStoredCookieKey,
  parseCookieKeyProbe,
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
  };
}

const launch = {
  platform: "win32" as const,
  userData: USER_DATA,
  execPath: String.raw`C:\App\Desktop.exe`,
  appPath: undefined,
};

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

it("does nothing when the key is stored, without looking for an earlier failure", () => {
  const spawn = vi.fn<CookieKeySpawn>();
  const { read, write } = disk({ [LOCAL_STATE]: WITH_KEY, [FAILED]: "{}" });
  expect(storeCookieKeyFirst(launch, { spawn, read, write })).toEqual({ kind: "none" });
  expect(spawn).not.toHaveBeenCalled();
  expect(read.mock.calls).toEqual([[LOCAL_STATE]]);
});

it("runs the writer on the same profile, waits for it and reports the stored key and its probe", () => {
  const files = disk();
  let t = 100;
  const spawn = vi.fn<CookieKeySpawn>(() => {
    files.files.set(LOCAL_STATE, WITH_KEY);
    t += 412.4;
    return { status: 0, stdout: `${COOKIE_KEY_PROBE_PREFIX}${PROBE}\r\n` };
  });
  const outcome = storeCookieKeyFirst(launch, {
    spawn,
    read: files.read,
    write: files.write,
    now: () => t,
    timeoutMs: 5000,
  });
  expect(spawn).toHaveBeenCalledWith(String.raw`C:\App\Desktop.exe`, cookieKeyWriterArgs(launch), {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "latin1",
    timeout: 5000,
  });
  expect(outcome).toEqual({ kind: "ran", ms: 412, stored: true, status: 0, probe: PROBE });
  expect(files.write).not.toHaveBeenCalled();
});

it("records a writer run that did not store the key, then skips the writer while the key is missing", () => {
  const files = disk();
  const spawn = vi.fn<CookieKeySpawn>(() => ({
    status: null,
    error: new Error("spawnSync Desktop.exe ETIMEDOUT"),
    stdout: "",
  }));
  const deps = {
    spawn,
    read: files.read,
    write: files.write,
    now: () => 0,
    date: () => new Date("2026-11-20T10:00:00.000Z"),
  };
  expect(storeCookieKeyFirst(launch, deps)).toEqual({
    kind: "ran",
    ms: 0,
    stored: false,
    status: null,
    error: "Error: spawnSync Desktop.exe ETIMEDOUT",
  });
  expect(JSON.parse(files.files.get(FAILED) ?? "")).toEqual({ failedAt: "2026-11-20T10:00:00.000Z", status: null });

  // Every later launch says it skipped, and when the run failed; none runs the writer again.
  for (let i = 0; i < 3; i++) {
    expect(storeCookieKeyFirst(launch, deps)).toEqual({ kind: "skipped", failedAt: "2026-11-20T10:00:00.000Z" });
  }
  expect(spawn).toHaveBeenCalledTimes(1);

  // Once the key is stored (the app's own clean quit writes it), the record no longer matters.
  files.files.set(LOCAL_STATE, WITH_KEY);
  expect(storeCookieKeyFirst(launch, deps)).toEqual({ kind: "none" });
});

it("runs the writer past an unreadable failure record, and on every launch when none can be written", () => {
  const unreadable = disk({ [FAILED]: "not json" });
  const spawn = vi.fn<CookieKeySpawn>(() => ({ status: 1, stdout: null }));
  storeCookieKeyFirst(launch, { spawn, read: unreadable.read, write: unreadable.write });
  expect(spawn).toHaveBeenCalledTimes(1);
  expect(unreadable.files.get(FAILED)).toContain("failedAt");

  const readOnly = disk();
  readOnly.write.mockImplementation(() => {
    throw new Error("EACCES");
  });
  const again = vi.fn<CookieKeySpawn>(() => ({ status: 1, stdout: null }));
  for (let i = 0; i < 2; i++) {
    expect(storeCookieKeyFirst(launch, { spawn: again, read: readOnly.read, write: readOnly.write })).toMatchObject({
      kind: "ran",
      stored: false,
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
