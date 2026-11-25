import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { cookieWakeStorage } from "./cookie-wake-storage.ts";

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
    writeFileSync(file, JSON.stringify([record, { ...record, scope: "https://foreign/" }, { ...record, since: null }]));
    expect(storage.read()).toEqual([record]);
    expect(log.warn).toHaveBeenCalledOnce();
    await storage.write([]);
    expect(cookieWakeStorage(dir, log).read()).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
