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
  dir = mkdtempSync(join(tmpdir(), "visual-mirror-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
it("loads only a valid versioned mirror and restores saved preferences on restart", () => {
  expect(createVisualThemeStore(dir, { log }).current()).toBe("auto");
  writeFileSync(join(dir, VISUAL_THEME_FILE), JSON.stringify({ version: 2, colorScheme: "dark" }));
  expect(createVisualThemeStore(dir, { log }).current()).toBe("auto");
  writeFileSync(join(dir, "prefs.json"), JSON.stringify({ theme: "light", width: 200 }));
  const store = createVisualThemeStore(dir, { log });
  expect(store.save("dark")).toBe(true);
  expect(createVisualThemeStore(dir, { log }).current()).toBe("dark");
  expect(JSON.parse(readFileSync(join(dir, "prefs.json"), "utf8"))).toEqual({ theme: "light", width: 200 });
});
it("reports persistence failure without changing the last durable mirror and retries", () => {
  const rename = vi.fn<(from: string, to: string) => void>((from, to) => nodeFs.renameSync(from, to));
  const store = createVisualThemeStore(dir, { log, fs: { ...nodeFs, renameSync: rename } });
  expect(store.save("dark")).toBe(true);
  rename.mockImplementationOnce(() => {
    throw new Error("disk unavailable");
  });
  expect(store.save("light")).toBe(false);
  expect(store.current()).toBe("dark");
  expect(createVisualThemeStore(dir, { log }).current()).toBe("dark");
  expect(store.save("light")).toBe(true);
  expect(createVisualThemeStore(dir, { log }).current()).toBe("light");
});
