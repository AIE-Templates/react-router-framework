import { runInNewContext } from "node:vm";

import { visualRecordKernel, type DesktopBridge } from "@repo/shared";
import { afterEach, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "~/config/storage";
import { visualCookie } from "~/config/visual-cookie";
import { visualBootstrapConfig, visualScript } from "~/managers/visual/bootstrap";
import { readVisualCookie } from "~/managers/visual/cookie";
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
  const key = STORAGE_KEYS.visualPreferences;
  const global = { colorScheme: opposite, direction: "rtl", reducedMotion: "reduce" } as const;
  const raw = visualRecordKernel.encode({ version: 1, stamp: { t: 1, id: "a" }, preferences: global });
  let mirror = raw;
  const pushVisual = vi.fn<DesktopBridge["pushVisual"]>(async (wire) => {
    mirror = wire;
    return "ok";
  });
  Object.defineProperty(window, "desktop", {
    configurable: true,
    value: {
      bootstrap: { fixedAppearance: fixed },
      visualSeed: { record: raw, pending: false },
      readVisual: () => ({ record: mirror, pending: false }),
      pushVisual,
    },
  });
  localStorage.setItem(key, raw);

  runInNewContext(visualScript(desktopVisualPrepaint), { window, document });
  expect(document.documentElement.dataset.colorScheme).toBe(fixed);
  expect(localStorage.getItem(key)).toBe(raw);
  const manager = createVisualManager({ host: window, nativeSource: desktopVisualSource });
  expect(manager.getSnapshot().resolved).toEqual({ colorScheme: fixed, direction: "rtl", reducedMotion: true });
  const disconnect = manager.connect();
  try {
    expect(pushVisual).not.toHaveBeenCalled();
    manager.actions.setDirection("ltr");
    expect(manager.getSnapshot().resolved).toEqual({ colorScheme: fixed, direction: "ltr", reducedMotion: true });
    expect(visualRecordKernel.decode(mirror).record?.preferences).toEqual({ ...global, direction: "ltr" });
    expect(localStorage.getItem(key)).toBe(mirror);
    expect(readVisualCookie(document.cookie, visualCookie.name)).toBe(mirror);
    manager.actions.setDirection("rtl");
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

it("E19 hands successive SPA edits between windows through the live bridge alone", async () => {
  let record: string | null = null;
  const readVisual = vi.fn<DesktopBridge["readVisual"]>(() => ({ record, pending: false }));
  const pushVisual = vi.fn<DesktopBridge["pushVisual"]>(async (value: string) => {
    record = value;
    return "ok" as const;
  });
  Object.defineProperty(window, "desktop", { configurable: true, value: { readVisual, pushVisual } });
  const config = { ...visualBootstrapConfig, cookieName: undefined };
  const options = { host: window, config, nativeSource: desktopVisualSource };
  const a = createVisualManager(options);
  const b = createVisualManager(options);
  const blocked = vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  const readCookie = vi.spyOn(Document.prototype, "cookie", "get");
  const writeCookie = vi.spyOn(Document.prototype, "cookie", "set");
  const closeA = a.connect();
  const closeB = b.connect();
  try {
    expect(b.getStatus().storage).toEqual({ local: "unavailable", cookie: "absent", native: "ok" });
    expect(pushVisual).not.toHaveBeenCalled();
    a.actions.setDirection("rtl");
    await Promise.resolve();
    expect(b.getSnapshot().preferences).toEqual({});
    readVisual.mockClear();
    b.actions.setReducedMotionPreference("reduce");
    await Promise.resolve();
    expect(readVisual).toHaveBeenCalledOnce();
    const both = { direction: "rtl", reducedMotion: "reduce" };
    expect(b.getSnapshot().preferences).toEqual(both);
    expect(visualRecordKernel.decode(record).record?.preferences).toEqual(both);
    window.dispatchEvent(new Event("pageshow"));
    expect(a.getSnapshot().preferences).toEqual(both);
    expect(pushVisual).toHaveBeenCalledTimes(2);
    expect(readCookie).not.toHaveBeenCalled();
    expect(writeCookie).not.toHaveBeenCalled();
  } finally {
    blocked.mockRestore();
    readCookie.mockRestore();
    writeCookie.mockRestore();
    closeA();
    closeB();
  }
});
