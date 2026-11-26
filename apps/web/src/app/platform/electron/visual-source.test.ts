import { runInNewContext } from "node:vm";

import { visualRecordKernel } from "@repo/shared";
import { afterEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { visualBootstrapConfig, visualScript } from "~/managers/visual/bootstrap";
import { createVisualManager } from "~/managers/visual/manager";

import { desktopVisualPrepaint, desktopVisualSource } from "./visual-source";

afterEach(() => {
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Path=/; Max-Age=0";
  delete window.frameworkVisualBootstrap;
  delete window.desktop;
});

it("ignores a URL appearance without a desktop bootstrap", () => {
  const previous = location.href;
  try {
    history.replaceState(null, "", "?windowAppearance=dark");
    runInNewContext(visualScript(desktopVisualPrepaint), { window, document });
    expect(window.frameworkVisualBootstrap?.fixedAppearance).toBeUndefined();
  } finally {
    history.replaceState(null, "", previous);
  }
});

it.each(["dark", "light"] as const)("keeps fixed %s across prepaint, hydration and global changes", (fixed) => {
  const opposite = fixed === "dark" ? "light" : "dark";
  Object.defineProperty(window, "desktop", { configurable: true, value: { bootstrap: { fixedAppearance: fixed } } });
  const key = STORAGE_KEYS.visualPreferences;
  const global = { colorScheme: opposite, direction: "rtl", reducedMotion: "reduce" } as const;
  const raw = visualRecordKernel.encode({ version: 1, stamp: { t: 1, id: "a" }, preferences: global });
  localStorage.setItem(key, raw);

  runInNewContext(visualScript(desktopVisualPrepaint), { window, document });
  expect(document.documentElement.dataset.colorScheme).toBe(fixed);
  expect(localStorage.getItem(key)).toBe(raw);
  const manager = createVisualManager({ host: window });
  expect(manager.getSnapshot().resolved).toEqual({ colorScheme: fixed, direction: "rtl", reducedMotion: true });
  const disconnect = manager.connect();
  try {
    manager.actions.setColorSchemePreference(fixed);
    manager.actions.setColorSchemePreference(opposite);
    expect(manager.getSnapshot().resolved.colorScheme).toBe(fixed);
    expect(manager.getSnapshot().preferences).toEqual(global);
    expect(visualRecordKernel.decode(localStorage.getItem(key)).record?.preferences).toEqual(global);
  } finally {
    disconnect();
  }
});

it.each([true, false])(
  "uses the document sample before paint and probes the live bridge on connection (SSR=%s)",
  (ssr) => {
    const raw = visualRecordKernel.encode({
      version: 1,
      stamp: { t: 1, id: "seed" },
      preferences: { direction: "rtl" },
    });
    const readVisual = vi.fn<() => { record: string; pending: boolean }>(() => ({ record: raw, pending: true }));
    const pushVisual = vi.fn<(raw: string) => Promise<"ok">>(async () => "ok");
    Object.defineProperty(window, "desktop", {
      configurable: true,
      value: { visualSeed: { record: raw, pending: true }, readVisual, pushVisual },
    });
    const config = { ...visualBootstrapConfig, cookieName: ssr ? visualCookie.name : undefined };
    runInNewContext(visualScript(desktopVisualPrepaint, config), { window, document });
    const manager = createVisualManager({
      host: window,
      config,
      nativeSource: desktopVisualSource,
      initialShell: ssr ? "desktop" : "web",
    });
    expect(readVisual).not.toHaveBeenCalled();
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
    const release = manager.connect();
    try {
      expect(readVisual).toHaveBeenCalledOnce();
      expect(manager.getStatus().storage.native).toBe("failed");
      expect(pushVisual).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEYS.visualPreferences)).toBe(raw);
      expect(document.cookie.includes(visualCookie.name + "=")).toBe(ssr);
      readVisual.mockReturnValue({ record: raw, pending: false });
      window.dispatchEvent(new Event("pageshow"));
      expect(manager.getStatus().storage.native).toBe("ok");
    } finally {
      release();
    }
  },
);
