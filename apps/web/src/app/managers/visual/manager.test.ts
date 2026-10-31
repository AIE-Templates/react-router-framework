import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { STORAGE_KEYS } from "../../config/storage";
import { visualBootstrapConfig, visualCodec, visualScript, visualServerAttributes } from "./bootstrap";
import { createVisualManager } from "./manager";

const key = STORAGE_KEYS.visualPreferences;
let dark = false;
let reduced = false;
let callbacks: Set<() => void>;
beforeEach(() => {
  localStorage.clear();
  delete window.frameworkVisualBootstrap;
  dark = false;
  reduced = false;
  callbacks = new Set();
  vi.stubGlobal("matchMedia", (query: string) => ({
    get matches() {
      return query.includes("color-scheme") ? dark : reduced;
    },
    addEventListener: (_: string, callback: () => void) => callbacks.add(callback),
    removeEventListener: (_: string, callback: () => void) => callbacks.delete(callback),
  }));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function stored(colorScheme = "dark", direction = "rtl", reducedMotion = "reduce") {
  localStorage.setItem(key, JSON.stringify({ version: 1, preferences: { colorScheme, direction, reducedMotion } }));
}
function create() {
  return createVisualManager({ host: window });
}
function signalStorage(eventKey: string | null = key) {
  window.dispatchEvent(new StorageEvent("storage", { key: eventKey }));
}

describe("visual state ownership", () => {
  it("separates hydration from the real client snapshot before connecting", () => {
    stored();
    const manager = create();
    expect(manager.getServerSnapshot().resolved.colorScheme).toBe("light");
    expect(manager.getSnapshot().resolved).toEqual({ colorScheme: "dark", direction: "rtl", reducedMotion: true });
    const snapshot = manager.getSnapshot();
    expect(manager.getSnapshot()).toBe(snapshot);
    const disconnect = manager.connect();
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    disconnect();
  });
  it("tracks both system preferences only while auto and releases listeners", () => {
    const manager = create();
    const disconnect = manager.connect();
    dark = true;
    reduced = true;
    callbacks.forEach((callback) => callback());
    expect(manager.getSnapshot().resolved).toMatchObject({ colorScheme: "dark", reducedMotion: true });
    expect(manager.getSnapshot().preferences.colorScheme).toBe("auto");
    manager.actions.setColorSchemePreference("light");
    manager.actions.setReducedMotionPreference("full");
    callbacks.forEach((callback) => callback());
    expect(manager.getSnapshot().resolved).toMatchObject({ colorScheme: "light", reducedMotion: false });
    disconnect();
    disconnect();
    expect(callbacks.size).toBe(0);
    manager.connect()();
    expect(callbacks.size).toBe(0);
  });
  it("keeps session state after persistence failure and retries unchanged commands", () => {
    stored("light", "ltr", "auto");
    const manager = create();
    const disconnect = manager.connect();
    const setter = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    manager.actions.setColorSchemePreference("dark");
    manager.actions.setDirection("rtl");
    expect(manager.getSnapshot().preferences.colorScheme).toBe("dark");
    expect(manager.getStatus().persistence).toBe("failed");
    setter.mockRestore();
    manager.actions.setDirection("rtl");
    expect(manager.getStatus().persistence).toBe("saved");
    expect(visualCodec.decode(localStorage.getItem(key))).toMatchObject({
      preferences: { colorScheme: "dark", direction: "rtl" },
    });
    disconnect();
  });
  it("handles cross-document updates, deletion, clear and avoids write echoes", () => {
    const manager = create();
    const disconnect = manager.connect();
    stored();
    const writer = vi.spyOn(Storage.prototype, "setItem");
    signalStorage();
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
    expect(writer).not.toHaveBeenCalled();
    localStorage.removeItem(key);
    signalStorage(null);
    expect(manager.getSnapshot().preferences).toEqual({ colorScheme: "auto", direction: "ltr", reducedMotion: "auto" });
    disconnect();
  });
  it("protects future versions until an explicit complete reset", () => {
    localStorage.setItem(key, '{"version":2,"preferences":{"direction":"rtl"}}');
    const manager = create();
    const disconnect = manager.connect();
    manager.actions.setDirection("rtl");
    expect(manager.getStatus().persistence).toBe("unsupported-version");
    expect(JSON.parse(localStorage.getItem(key)!).version).toBe(2);
    manager.actions.resetVisualPreferences();
    expect(JSON.parse(localStorage.getItem(key)!).version).toBe(1);
    disconnect();
  });
  it("resets one field without losing unrelated preferences or application keys", () => {
    stored();
    localStorage.setItem("another-app", "keep");
    const manager = create();
    manager.actions.resetColorSchemePreference();
    expect(manager.getSnapshot().preferences).toEqual({
      colorScheme: "auto",
      direction: "rtl",
      reducedMotion: "reduce",
    });
    manager.actions.resetVisualPreferences();
    expect(localStorage.getItem("another-app")).toBe("keep");
  });
  it("executes the exact prepaint payload without module dependencies", () => {
    stored("auto");
    dark = true;
    // The application executes these bytes through a nonce/hash-authorized script, before hydration.
    // oxlint-disable-next-line typescript/no-implied-eval -- Execute the exact generated prepaint payload in this isolated test.
    const execute = new Function("window", "document", visualScript());
    execute(window, document);
    expect(window.frameworkVisualBootstrap?.state.preferences.colorScheme).toBe("auto");
    expect(document.documentElement.dataset.colorScheme).toBe("dark");
    expect(document.documentElement.dir).toBe("rtl");
    expect(create().getSnapshot().resolved.colorScheme).toBe("dark");
    expect(visualBootstrapConfig.additionalColorSchemeAttributes).toEqual(["data-mantine-color-scheme"]);
  });
  it("defaults invalid fields independently", () => {
    expect(visualCodec.decode('{"version":1,"preferences":{"direction":"rtl","colorScheme":"bogus"}}')).toMatchObject({
      preferences: { direction: "rtl", colorScheme: "auto", reducedMotion: "auto" },
    });
  });
});

it("renders explicit integration seeds without resolving unknown automatic server preferences", () => {
  const config = { ...visualBootstrapConfig, additionalColorSchemeAttributes: ["data-example-scheme", "onclick"] };
  expect(visualServerAttributes("dark", config)).toEqual({ "data-example-scheme": "dark" });
  expect(visualServerAttributes("auto", config)).toEqual({});
});

it("does not replay the prepaint snapshot after later writes or deletion", () => {
  stored("dark");
  window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, undefined, window);
  const first = create();
  first.actions.setColorSchemePreference("light");
  expect(create().getSnapshot().preferences.colorScheme).toBe("light");
  localStorage.removeItem(key);
  expect(create().getSnapshot().preferences.colorScheme).toBe("auto");
});
it("retains the prepaint preference if storage becomes inaccessible before hydration", () => {
  stored("dark");
  window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, undefined, window);
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(create().getSnapshot().preferences.colorScheme).toBe("dark");
  expect(create().getStatus().persistence).toBe("unavailable");
});

it("reconciles deletion while disconnected without reviving an old request seed", () => {
  const seed = { colorScheme: "dark", direction: "rtl", reducedMotion: "reduce" } as const;
  const manager = createVisualManager({ host: window, initialPreferences: seed });
  const disconnect = manager.connect();
  expect(manager.getSnapshot().preferences).toEqual(seed);
  manager.actions.setDirection("rtl");
  disconnect();
  localStorage.removeItem(key);
  const reconnect = manager.connect();
  expect(manager.getSnapshot().preferences).toEqual({ colorScheme: "auto", direction: "ltr", reducedMotion: "auto" });
  expect(localStorage.getItem(key)).toBeNull();
  reconnect();
});

it("preserves a never-persisted seed across effect replay and unavailable reconnects", () => {
  const seed = { colorScheme: "dark", direction: "rtl", reducedMotion: "reduce" } as const;
  const manager = createVisualManager({ host: window, initialPreferences: seed });
  manager.connect()();
  manager.connect()();
  expect(manager.getSnapshot().preferences).toEqual(seed);
  manager.actions.setDirection("rtl");
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const disconnect = manager.connect();
  expect(manager.getSnapshot().preferences).toEqual(seed);
  expect(manager.getStatus().persistence).toBe("unavailable");
  disconnect();
});
it("observes removal between construction and the first connection", () => {
  stored();
  const manager = create();
  localStorage.removeItem(key);
  manager.connect()();
  expect(manager.getSnapshot().preferences.colorScheme).toBe("auto");
});

it("keeps the request seed when an existing storage record is malformed", () => {
  const seed = { colorScheme: "dark", direction: "rtl", reducedMotion: "reduce" } as const;
  localStorage.setItem(key, "malformed");
  const manager = createVisualManager({ host: window, initialPreferences: seed });
  expect(manager.getSnapshot().preferences).toEqual(seed);
  const disconnect = manager.connect();
  expect(manager.getSnapshot().preferences).toEqual(seed);
  expect(localStorage.getItem(key)).toBe("malformed");
  disconnect();
});

it.each(["failed-write", "unavailable-read"])("refreshes automatic resolution on reconnect after %s", (failure) => {
  const manager = create();
  const disconnect = manager.connect();
  if (failure === "failed-write") {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    manager.actions.setDirection("rtl");
  } else {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
  }
  const preferences = manager.getSnapshot().preferences;
  disconnect();
  dark = true;
  reduced = true;
  const reconnect = manager.connect();
  expect(manager.getSnapshot().preferences).toEqual(preferences);
  expect(manager.getSnapshot().resolved).toMatchObject({ colorScheme: "dark", reducedMotion: true });
  expect(manager.getStatus().persistence).toBe(failure === "failed-write" ? "failed" : "unavailable");
  reconnect();
});
