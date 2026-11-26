import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createVisualRecordKernel, VISUAL_DEFAULTS, visualRecordKernel, type VisualPreferences } from "@repo/shared";
import { afterEach, expect, it, vi } from "vitest";

import { nodeFs } from "./atomic-file.ts";
import { createVisualMirror } from "./visual-mirror.ts";

const directories: string[] = [];
const log = { warn: vi.fn<() => void>() };
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "visual-mirror-"));
  directories.push(dir);
  const fs = {
    ...nodeFs,
    readFileSync: (path: string) => readFileSync(path, "utf8"),
    renameSync: vi.fn<typeof nodeFs.renameSync>((from, to) => nodeFs.renameSync(from, to)),
    sleep: vi.fn<(ms: number) => void>(),
  };
  return { file: join(dir, "visual.json"), fs, start: () => createVisualMirror(dir, { log, fs }) };
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const raw = (t: number, preferences: Partial<VisualPreferences>) =>
  visualRecordKernel.encode({ version: 1, stamp: { t, id: "a" }, preferences });
const older = raw(1, { direction: "rtl" });
const newer = raw(2, { colorScheme: "dark", reducedMotion: "reduce" });
it("starts without writing and replaces a corrupt mirror with a complete canonical record", () => {
  const { file, start } = fixture();
  expect(start().read()).toEqual({ record: null, pending: false });
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, "invalid");
  const mirror = start();
  expect(mirror.colorScheme()).toBe(VISUAL_DEFAULTS.colorScheme);
  expect(mirror.push(older)).toBe("ok");
  expect(mirror.push(JSON.stringify(JSON.parse(newer), null, 2))).toBe("ok");
  expect(mirror.push("invalid")).toBe("failed");
  expect(mirror.push(older)).toBe("ok");
  expect(readFileSync(file, "utf8")).toBe(newer);
  expect(start().read()).toEqual({ record: newer, pending: false });
});
it("G10 derives missing choices from product defaults on construction and reset", () => {
  const kernel = createVisualRecordKernel({ ...VISUAL_DEFAULTS, colorScheme: "light" });
  const effective = vi.spyOn(visualRecordKernel, "effective").mockImplementation(kernel.effective);
  try {
    const { start } = fixture();
    const mirror = start();
    expect(mirror.colorScheme()).toBe("light");
    mirror.push(newer);
    mirror.push(raw(3, {}));
    expect(mirror.colorScheme()).toBe("light");
    expect(start().colorScheme()).toBe("light");
  } finally {
    effective.mockRestore();
  }
});
it.each(["equal", "older", "invalid", "window or quit"] as const)(
  "retries pending data on %s without changing its stamp",
  (trigger) => {
    const { fs, start } = fixture();
    const mirror = start();
    const notify = vi.fn<typeof mirror.colorScheme>(() => mirror.colorScheme());
    mirror.onColorSchemeChange(notify);
    mirror.push(older);
    fs.renameSync.mockImplementation(() => {
      throw new Error("disk unavailable");
    });
    try {
      expect(mirror.push(newer)).toBe("failed");
      expect(mirror.push(older)).toBe("ok");
      expect(mirror.push(newer)).toBe("failed");
      expect(mirror.read()).toEqual({ record: newer, pending: true });
      expect(notify).toHaveLastReturnedWith("dark");
      expect(start().read()).toEqual({ record: older, pending: false });
    } finally {
      fs.renameSync.mockImplementation((from, to) => nodeFs.renameSync(from, to));
    }
    const result =
      trigger === "window or quit"
        ? mirror.retryPending()
        : mirror.push(trigger === "equal" ? newer : trigger === "older" ? older : "{}");
    const expected = { equal: "ok", older: "ok", invalid: "failed", "window or quit": undefined };
    expect(result).toBe(expected[trigger]);
    expect(mirror.read()).toEqual({ record: newer, pending: false });
    expect(start().read()).toEqual(mirror.read());
    const writes = fs.renameSync.mock.calls.length;
    mirror.push(newer);
    mirror.retryPending();
    expect(fs.renameSync).toHaveBeenCalledTimes(writes);
    expect(notify).toHaveBeenCalledOnce();
  },
);

it("supersedes a pending write with the new maximum and reports durability independently of native drawing", () => {
  const { fs, start } = fixture();
  const mirror = start();
  const latest = raw(3, { colorScheme: "light" });
  mirror.onColorSchemeChange(() => {
    throw new Error("appearance unavailable");
  });
  const applied = vi.fn<() => string>(() => mirror.colorScheme());
  mirror.onColorSchemeChange(applied);
  fs.renameSync.mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  expect(mirror.push(newer)).toBe("failed");
  expect(applied).toHaveLastReturnedWith("dark");
  expect(mirror.push(latest)).toBe("ok");
  expect(applied).toHaveLastReturnedWith("light");
  expect(mirror.read()).toEqual({ record: latest, pending: false });
  expect(start().read()).toEqual(mirror.read());
});
