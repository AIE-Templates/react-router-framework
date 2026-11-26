import { runInNewContext } from "node:vm";

import { visualRecordKernel as records, type VisualPreferences } from "@repo/shared";
import { afterEach, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";

import { readVisualCookie, writeVisualCookie } from "./cookie";

async function loadProduct(colorScheme: "auto" | "light") {
  vi.resetModules();
  vi.doMock(import("@repo/shared"), async (original) => {
    const shared = await original();
    const defaults = { ...shared.VISUAL_DEFAULTS, colorScheme };
    return { ...shared, VISUAL_DEFAULTS: defaults, visualRecordKernel: shared.createVisualRecordKernel(defaults) };
  });
  const bootstrap = await import("./bootstrap");
  const { createVisualManager } = await import("./manager");
  return { ...bootstrap, createVisualManager };
}

const fixedDark = () => ({ fixedAppearance: "dark" as const, record: null });

function expectPrepaint(
  product: Awaited<ReturnType<typeof loadProduct>>,
  preferences: Partial<VisualPreferences>,
  colorScheme: "light" | "dark",
  fixed?: typeof fixedDark,
) {
  const direct = product.visualCodec.read(product.visualBootstrapConfig, window, fixed);
  // A fresh document starts with no attributes from an earlier execution.
  const document = window.document.implementation.createHTMLDocument();
  runInNewContext(product.visualScript(fixed), { window, document });
  expect(window.frameworkVisualBootstrap).toEqual(direct);
  expect(direct.state).toEqual({
    preferences,
    resolved: {
      colorScheme,
      direction: preferences.direction ?? "ltr",
      reducedMotion: preferences.reducedMotion === "reduce",
    },
  });
  expect(document.documentElement.dataset.colorScheme).toBe(colorScheme);
  expect(document.documentElement.dir).toBe(direct.state.resolved.direction);
  expect(document.documentElement.dataset.reducedMotion).toBe(direct.state.resolved.reducedMotion ? "reduce" : "full");
  return direct.record;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock(import("@repo/shared"));
  vi.resetModules();
  delete window.frameworkVisualBootstrap;
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Max-Age=0; Path=/";
});

function darkSystem() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(prefers-color-scheme: dark)",
    addEventListener() {},
    removeEventListener() {},
  }));
}

it.each([
  ["G8", {}, "dark"],
  ["G9", { colorScheme: "light" }, "light"],
] as const)(
  "%s reopens the same sparse record after a light-to-auto product upgrade",
  async (_, preferences, upgraded) => {
    darkSystem();
    const light = await loadProduct("light");
    const stored = { version: 1, stamp: { t: 1, id: "a" }, preferences } as const;
    const raw = records.encode(stored);
    localStorage.setItem(light.visualBootstrapConfig.storageKey, raw);
    writeVisualCookie(window, raw);
    const local = vi.spyOn(Storage.prototype, "setItem");
    const cookie = vi.spyOn(document, "cookie", "set");
    expect(expectPrepaint(light, preferences, "light")).toEqual(stored);
    const auto = await loadProduct("auto");
    expect(expectPrepaint(auto, preferences, upgraded)).toEqual(stored);
    expect(local).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  },
);

it.each(["auto", "light"] as const)("G1/G2/G10 apply %s defaults without creating a record", async (scheme) => {
  darkSystem();
  const product = await loadProduct(scheme);
  const resolved = scheme === "auto" ? "dark" : "light";
  const local = vi.spyOn(Storage.prototype, "setItem");
  const cookie = vi.spyOn(document, "cookie", "set");
  expect(expectPrepaint(product, {}, resolved)).toBeUndefined();
  const manager = product.createVisualManager({ host: window });
  const close = manager.connect();
  try {
    expect(manager.getSnapshot().resolved.colorScheme).toBe(resolved);
    expect(expectPrepaint(product, {}, "dark", fixedDark)).toBeUndefined();
    expect(manager.getSnapshot().resolved.colorScheme).toBe(resolved);
    expect(local).not.toHaveBeenCalled();
    expect(cookie).not.toHaveBeenCalled();
  } finally {
    close();
  }
});

it("G3–G7 replay each sparse edit and reset with a light product default", async () => {
  darkSystem();
  const product = await loadProduct("light");
  const manager = product.createVisualManager({ host: window });
  const close = manager.connect();
  let previous = -1;
  function saved(preferences: Partial<VisualPreferences>, scheme: "light" | "dark") {
    const record = expectPrepaint(product, preferences, scheme)!;
    const raw = records.encode(record);
    expect(record.preferences).toEqual(preferences);
    expect(record.stamp.t).toBeGreaterThan(previous);
    expect(localStorage.getItem(product.visualBootstrapConfig.storageKey)).toBe(raw);
    expect(readVisualCookie(document.cookie, visualCookie.name)).toBe(raw);
    expect(manager.getSnapshot()).toEqual(window.frameworkVisualBootstrap?.state);
    previous = record.stamp.t;
  }
  try {
    manager.actions.setReducedMotionPreference("reduce");
    saved({ reducedMotion: "reduce" }, "light");
    manager.actions.setColorSchemePreference("light");
    saved({ colorScheme: "light", reducedMotion: "reduce" }, "light");
    manager.actions.setColorSchemePreference("dark");
    saved({ colorScheme: "dark", reducedMotion: "reduce" }, "dark");
    manager.actions.resetColorSchemePreference();
    saved({ reducedMotion: "reduce" }, "light");
    manager.actions.setDirection("rtl");
    saved({ direction: "rtl", reducedMotion: "reduce" }, "light");
    manager.actions.resetVisualPreferences();
    saved({}, "light");
  } finally {
    close();
  }
});

it.each([{ colorScheme: "blue" }, { extra: "bad" }])(
  "G11 discards the whole invalid prepaint record %o",
  async (invalid) => {
    darkSystem();
    const product = await loadProduct("light");
    const raw = JSON.stringify({ version: 1, stamp: { t: 8, id: "a" }, preferences: { direction: "rtl", ...invalid } });
    localStorage.setItem(product.visualBootstrapConfig.storageKey, raw);
    expect(expectPrepaint(product, {}, "light")).toBeUndefined();
    expect(localStorage.getItem(product.visualBootstrapConfig.storageKey)).toBe(raw);
  },
);
