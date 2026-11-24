import { afterEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "~/config/storage";
import { visualScript } from "~/managers/visual/bootstrap";
import { createVisualManager } from "~/managers/visual/manager";

import { desktopPrepaintTheme, desktopWindowAppearance } from "./visual-prepaint";

const storage = (direction: string) =>
  JSON.stringify({ version: 1, preferences: { colorScheme: "light", direction, reducedMotion: "reduce" } });

afterEach(() => {
  localStorage.clear();
  delete window.frameworkVisualBootstrap;
  delete window.desktop;
  vi.restoreAllMocks();
});

it.each(["ssr", "spa"])("uses the committed document seed before paint and on hydration in %s", (mode) => {
  const key = STORAGE_KEYS.visualPreferences;
  const seed = { preference: "dark", revision: 3 } as const;
  Object.defineProperty(window, "desktop", { configurable: true, value: { visualTheme: seed } });

  localStorage.setItem(key, storage("rtl"));
  const script = visualScript(undefined, {
    read: desktopPrepaintTheme,
    seed: mode === "ssr" ? { preference: "light", revision: 2 } : undefined,
  });
  // oxlint-disable-next-line typescript/no-implied-eval -- Exercise the serialized prepaint bytes before hydration.
  new Function("window", "document", script)(window, document);
  expect(document.documentElement.dataset.colorScheme).toBe("dark");
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
  expect(document.documentElement.dir).toBe("rtl");
  const manager = createVisualManager({ host: window });
  const release = manager.connect();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  localStorage.setItem(key, storage("ltr"));
  window.dispatchEvent(new StorageEvent("storage", { key }));
  expect(manager.getSnapshot().preferences).toMatchObject({ colorScheme: "dark", direction: "ltr" });
  expect(writes).toHaveBeenCalledOnce();
  manager.actions.setDirection("rtl");
  expect(JSON.parse(localStorage.getItem(key)!).preferences).toEqual({ direction: "rtl", reducedMotion: "reduce" });
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(manager.getSnapshot().preferences).toEqual({ colorScheme: "dark", direction: "ltr", reducedMotion: "auto" });
  release();
});

it.each(["dark", "light"] as const)(
  "keeps fixed %s through prepaint, hydration and later app theme commits",
  (fixed) => {
    const opposite = fixed === "dark" ? "light" : "dark";
    const seed = { preference: opposite, revision: 3 } as const;
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { bootstrap: { fixedAppearance: fixed }, visualTheme: seed },
    });
    const script = visualScript(undefined, {
      read: desktopPrepaintTheme,
      readFixedAppearance: desktopWindowAppearance,
    });
    // oxlint-disable-next-line typescript/no-implied-eval -- Run the actual serialized document script.
    new Function("window", "document", script)(window, document);
    expect(document.documentElement.dataset.colorScheme).toBe(fixed);
    const visual = createVisualManager({ host: window });
    const disconnect = visual.connect();
    try {
      for (const [revision, preference] of [
        [4, fixed],
        [5, opposite],
      ] as const) {
        visual.applyExternalColorScheme({ revision, preference });
        expect(visual.getSnapshot().preferences.colorScheme).toBe(preference);
        expect(visual.getSnapshot().resolved.colorScheme).toBe(fixed);
        expect(document.documentElement.dataset.mantineColorScheme).toBe(fixed);
      }
      expect(localStorage.length).toBe(0);
    } finally {
      disconnect();
    }
  },
);
