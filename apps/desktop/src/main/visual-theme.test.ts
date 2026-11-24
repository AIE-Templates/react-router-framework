import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { nodeFs } from "./atomic-file.ts";
import { createVisualThemeStore, VISUAL_THEME_FILE } from "./visual-theme.ts";
const log = {
  warn: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
};
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "visual-record-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
it("loads only a valid versioned record and restores saved preferences on restart", () => {
  expect(createVisualThemeStore(dir, { log }).current().preference).toBe("auto");
  writeFileSync(join(dir, VISUAL_THEME_FILE), JSON.stringify({ version: 2, colorScheme: "dark" }));
  expect(createVisualThemeStore(dir, { log }).current().preference).toBe("auto");
  writeFileSync(join(dir, "prefs.json"), JSON.stringify({ theme: "light", width: 200 }));
  const store = createVisualThemeStore(dir, { log });
  expect(store.save("dark")).toBe(true);
  expect(createVisualThemeStore(dir, { log }).current().preference).toBe("dark");
  expect(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8"))).toEqual({ theme: "light", width: 200 });
});
it("reports persistence failure without changing the last durable record and retries", () => {
  const rename = vi.fn<(from: string, to: string) => void>((from, to) => nodeFs.renameSync(from, to));
  const store = createVisualThemeStore(dir, { log, fs: { ...nodeFs, renameSync: rename } });
  const listener = vi.fn<() => void>();
  const unsubscribe = store.subscribe(listener);
  expect(store.save("dark")).toBe(true);
  expect(listener).toHaveBeenCalledExactlyOnceWith({ preference: "dark", revision: 1 });
  rename.mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  expect(store.save("light")).toBe(false);
  expect(store.current()).toEqual({ preference: "dark", revision: 1 });
  expect(listener).toHaveBeenCalledTimes(1);
  expect(createVisualThemeStore(dir, { log }).current().preference).toBe("dark");
  expect(store.save("light")).toBe(true);
  expect(listener).toHaveBeenLastCalledWith({ preference: "light", revision: 2 });
  unsubscribe();
  expect(createVisualThemeStore(dir, { log }).current().preference).toBe("light");
});
