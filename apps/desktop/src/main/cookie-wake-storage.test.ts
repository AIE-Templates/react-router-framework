import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { cookieWakeStorage } from "./cookie-wake-storage.ts";

vi.mock(import("node:fs"), async (importOriginal) => {
  const fs = { ...(await importOriginal()) };
  vi.spyOn(fs, "readFileSync");
  return fs;
});

vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const fs = { ...(await importOriginal()) };
  vi.spyOn(fs, "rename");
  return fs;
});

it("keeps the previous complete index visible until the replacement is renamed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wake-"));
  const file = join(dir, "cookie-wake-index.json");
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  const storage = cookieWakeStorage(dir, log);
  const previous = [{ scope: "app://app/", name: "old", eligible: true, since: 1 }];
  const next = [...previous, { ...previous[0], name: "new" }];
  const { rename: replace } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try {
    await storage.write(previous);
    vi.mocked(rename)
      .mockClear()
      .mockImplementationOnce(async (temp, destination) => {
        expect(destination).toBe(file);
        expect(temp).not.toBe(file);
        expect(readFileSync(file, "utf8")).toBe(JSON.stringify(previous));
        expect(readFileSync(temp, "utf8")).toBe(JSON.stringify(next));
        await replace(temp, destination);
      });
    await storage.write(next);
    expect(storage.read()).toEqual(next);
    expect(readdirSync(dir)).toEqual(["cookie-wake-index.json"]);
    expect(rename).toHaveBeenCalledOnce();
  } finally {
    vi.mocked(rename).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each(["EACCES", "EIO", "EISDIR"])("preserves the wake index for the rest of the launch after %s", async (code) => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wake-"));
  const file = join(dir, "cookie-wake-index.json");
  const saved = { scope: "app://app/", name: "saved", eligible: true, since: 1 };
  const original = JSON.stringify([saved]) + "\n";
  const error = Object.assign(new Error(code), { code });
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  try {
    writeFileSync(file, original);
    const storage = cookieWakeStorage(dir, log);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw error;
    });
    expect(storage.read()).toEqual([]);
    await storage.write([]);
    expect(storage.read()).toEqual([]);
    await storage.write([{ ...saved, name: "new" }]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith({ err: error }, expect.stringMatching(/wake index/i));
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(readdirSync(dir)).toEqual(["cookie-wake-index.json"]);

    const nextLaunch = cookieWakeStorage(dir, log);
    expect(nextLaunch.read()).toEqual([saved]);
    await nextLaunch.write([]);
    expect(readFileSync(file, "utf8")).toBe("[]");
  } finally {
    vi.mocked(readFileSync).mockReset();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reopens a durably replaced index, preserves valid records and rejects foreign or malformed hints", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wake-"));
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  try {
    const storage = cookieWakeStorage(dir, log);
    expect(storage.read()).toEqual([]);
    const record = { scope: "app://app/area/", url: "app://app/area/page", name: "x", eligible: true, since: 100 };
    await storage.write([record]);
    const [name] = readdirSync(dir);
    expect(readdirSync(dir)).toHaveLength(1);
    const file = join(dir, name);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([record]);
    expect(cookieWakeStorage(dir, log).read()).toEqual([record]);
    const damaged = Buffer.from(
      JSON.stringify([record, { ...record, scope: "https://foreign/" }, { ...record, since: null }]),
    );
    writeFileSync(file, damaged);
    expect(storage.read()).toEqual([record]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(readFileSync(file)).toEqual(damaged);
    const next = { ...record, name: "new" };
    await storage.write([record, next]);
    expect(cookieWakeStorage(dir, log).read()).toEqual([record, next]);
    expect(readFileSync(file + ".corrupt")).toEqual(damaged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it.each([
  ["malformed JSON", Buffer.from([0x7b, 0xff])],
  ["a non-array root", Buffer.from("{}\n")],
] as const)("backs up %s byte-for-byte and accepts a new index", async (_label, damaged) => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wake-"));
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  try {
    const file = join(dir, "cookie-wake-index.json");
    writeFileSync(file + ".corrupt", "previous backup");
    writeFileSync(file, damaged);
    const storage = cookieWakeStorage(dir, log);
    expect(storage.read()).toEqual([]);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(readFileSync(file)).toEqual(damaged);
    expect(readFileSync(file + ".corrupt")).toEqual(damaged);
    const record = { scope: "app://app/", name: "restored", eligible: true, since: 1 };
    await storage.write([record]);
    expect(cookieWakeStorage(dir, log).read()).toEqual([record]);
    expect(readFileSync(file + ".corrupt")).toEqual(damaged);
    expect(log.warn).toHaveBeenCalledOnce();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("logs a failed backup, keeps valid hints and continues writing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cookie-wake-"));
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  try {
    const file = join(dir, "cookie-wake-index.json");
    const record = { scope: "app://app/", name: "existing", eligible: true, since: 1 };
    const damaged = Buffer.from(JSON.stringify([record, null]));
    writeFileSync(file, damaged);
    const storage = cookieWakeStorage(dir, log);
    mkdirSync(file + ".corrupt");
    try {
      expect(storage.read()).toEqual([record]);
      expect(log.warn).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/back up/i));
      await storage.write([record]);
      expect(storage.read()).toEqual([record]);
    } finally {
      rmSync(file + ".corrupt", { recursive: true, force: true });
    }
    writeFileSync(file, damaged);
    expect(storage.read()).toEqual([record]);
    expect(readFileSync(file + ".corrupt")).toEqual(damaged);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
