import { VISUAL_DEFAULTS, visualRecordKernel as records, type VisualPreferences } from "@repo/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { visualCookie } from "~/config/visual-cookie";

import { visualBootstrapConfig, visualCodec } from "./bootstrap";
import { readVisualCookie, writeVisualCookie } from "./cookie";
import { createVisualManager } from "./manager";
import type { NativeVisualSource, StoreStatus } from "./types";

const key = visualBootstrapConfig.storageKey;
const releases: (() => void)[] = [];
function raw(t: number, preferences: Partial<VisualPreferences> = {}, id = "a") {
  return records.encode({ version: 1, stamp: { t, id }, preferences });
}
function local() {
  return localStorage.getItem(key);
}
function cookie() {
  return readVisualCookie(document.cookie, visualCookie.name);
}
function tab(options: Parameters<typeof createVisualManager>[0] = {}) {
  const manager = createVisualManager({ host: window, ...options });
  releases.push(manager.connect());
  return manager;
}
const spa = { config: { ...visualBootstrapConfig, cookieName: undefined } };
function signal() {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw(9999, { direction: "rtl" }) }));
}
function restore() {
  window.dispatchEvent(new Event("pageshow"));
}
function cleanupStores() {
  // Accessor spies on jsdom's inherited getter and setter may leave an own descriptor.
  Reflect.deleteProperty(document, "cookie");
  localStorage.clear();
  document.cookie = visualCookie.name + "=; Max-Age=0; Path=/";
  delete window.frameworkVisualBootstrap;
}
beforeEach(cleanupStores);
afterEach(() => {
  while (releases.length) releases.pop()!();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  cleanupStores();
});

it("E18 creates no records on initial connect, event, retry or restore, even for invalid sources", () => {
  localStorage.setItem(key, "{}");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const writeCookie = vi.spyOn(document, "cookie", "set");
  const first = tab();
  const second = tab();
  signal();
  restore();
  first.actions.retry();
  expect(first.getSnapshot()).toEqual(second.getSnapshot());
  expect(first.getSnapshot().preferences).toEqual({});
  expect(write).not.toHaveBeenCalled();
  expect(writeCookie).not.toHaveBeenCalled();
});
it("G4–G7 persist explicit defaults, delete individual fields and publish a timestamped whole reset", () => {
  const manager = tab();
  const { actions } = manager;
  function saved(preferences: Partial<VisualPreferences>) {
    const record = records.decode(local()).record!;
    expect(record.preferences).toEqual(preferences);
    expect(manager.getSnapshot().preferences).toEqual(preferences);
    expect(cookie()).toBe(records.encode(record));
    return record.stamp.t;
  }
  actions.setReducedMotionPreference("reduce");
  saved({ reducedMotion: "reduce" });
  actions.setColorSchemePreference(VISUAL_DEFAULTS.colorScheme);
  saved({ colorScheme: "auto", reducedMotion: "reduce" });
  actions.setDirection("rtl");
  const before = saved({ colorScheme: "auto", direction: "rtl", reducedMotion: "reduce" });
  actions.resetColorSchemePreference();
  expect(saved({ direction: "rtl", reducedMotion: "reduce" })).toBeGreaterThan(before);
  actions.resetReducedMotionPreference();
  saved({ direction: "rtl" });
  actions.resetDirection();
  const empty = saved({});
  actions.resetVisualPreferences();
  expect(saved({})).toBeGreaterThan(empty);
});
it("E1/E13 reads the latest observable record before committing without backfilling intermediate values", () => {
  const first = tab();
  const second = tab();
  vi.spyOn(Date, "now").mockReturnValue(500);
  first.actions.setDirection("rtl");
  vi.mocked(Date.now).mockReturnValue(100);
  const writer = vi.spyOn(Storage.prototype, "setItem");
  localStorage.removeItem(key);
  second.actions.setColorSchemePreference("dark");
  expect(records.decode(local()).record).toMatchObject({
    stamp: { t: 501 },
    preferences: { direction: "rtl", colorScheme: "dark" },
  });
  expect(writer).toHaveBeenCalledTimes(1);
  signal();
  expect(first.getSnapshot()).toEqual(second.getSnapshot());
});
it("re-reads storage on events, repairs deletion from memory and skips equal targets", () => {
  const manager = tab();
  const value = raw(4, { direction: "rtl" });
  localStorage.setItem(key, value);
  const write = vi.spyOn(Storage.prototype, "setItem");
  signal();
  expect(manager.getSnapshot().preferences).toEqual({ direction: "rtl" });
  expect(cookie()).toBe(value);
  expect(write).not.toHaveBeenCalled();
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null }));
  expect(local()).toBe(value);
  signal();
  expect(write).toHaveBeenCalledTimes(1);
});
it.each(["local", "cookie"] as const)(
  "E3 rechecks %s immediately before repair and skips a newly updated target",
  (store) => {
    const old = raw(1, { direction: "rtl" });
    const newer = raw(2, { direction: "ltr" });
    let reads = 0;
    if (store === "local") {
      writeVisualCookie(window, old);
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => (++reads === 1 ? null : newer));
    } else {
      localStorage.setItem(key, old);
      vi.spyOn(document, "cookie", "get").mockImplementation(() =>
        ++reads === 1 ? "" : visualCookie.name + "=" + encodeURIComponent(newer),
      );
    }
    const write = vi.spyOn(Storage.prototype, "setItem");
    const setCookie = vi.spyOn(document, "cookie", "set");
    const manager = tab();
    expect(reads).toBe(2);
    expect(write).not.toHaveBeenCalled();
    expect(setCookie).toHaveBeenCalledTimes(store === "local" ? 1 : 0);
    expect(manager.getSnapshot().preferences).toEqual({ direction: "ltr" });
    restore();
    expect(manager.getSnapshot().preferences).toEqual({ direction: "ltr" });
  },
);
it.each([true, false])(
  "E2/E14 simultaneous reset and field edit converge when winner remains observable: %s",
  (survives) => {
    const b = tab(spa);
    const a = tab(spa);
    vi.spyOn(Date, "now").mockReturnValueOnce(10).mockReturnValue(20);
    const write = localStorage.setItem.bind(localStorage);
    // B has completed its read and stamp. Let A commit and optionally close before releasing B's write.
    const gate = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(function (this: Storage, k, v) {
      a.actions.resetVisualPreferences();
      if (!survives) releases.pop()!();
      write(k, v);
    });
    try {
      b.actions.setDirection("rtl");
      expect(records.decode(local()).record?.stamp.t).toBe(10);
      signal();
      expect(tab(spa).getSnapshot().preferences).toEqual(survives ? {} : { direction: "rtl" });
      expect(records.decode(local()).record?.stamp.t).toBe(survives ? 20 : 10);
    } finally {
      gate.mockRestore();
    }
  },
);
it("E3/E4 repairs an interrupted stale backfill, including SSR while its cookie is behind", () => {
  const a = tab();
  a.actions.setDirection("rtl");
  const old = cookie()!;
  document.cookie = visualCookie.name + "=; Max-Age=0; Path=/";
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.set!.bind(document);
  const gate = vi.spyOn(document, "cookie", "set").mockImplementationOnce((value) => {
    a.actions.setColorSchemePreference("dark");
    setter(value);
  });
  try {
    tab();
    releases.pop()!();
    expect(cookie()).toBe(old);
    const current = local();
    expect(current).not.toBe(old);
    const handoff = visualCodec.read(visualBootstrapConfig, window);
    expect(handoff.record).toEqual(records.decode(current).record);
    // Now only A's memory retains the maximum; a freshly opened document cannot observe it yet.
    localStorage.setItem(key, old);
    expect(visualCodec.read(visualBootstrapConfig, window).record).toEqual(records.decode(old).record);
    restore();
    expect(local()).toBe(current);
    expect(cookie()).toBe(current);
  } finally {
    gate.mockRestore();
  }
});
it("E5/E6/E11 keeps a stale request seed out of live selection and new tabs agree before any event", () => {
  const original = raw(1, { direction: "ltr" });
  writeVisualCookie(window, original);
  const initialRecord = records.decode(cookie()).record;
  const a = tab();
  a.actions.setDirection("rtl");
  const newer = cookie()!;
  localStorage.setItem(key, original);
  window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window);
  const b = createVisualManager({ host: window, initialRecord });
  expect(b.getServerSnapshot().preferences.direction).toBe("ltr");
  expect(b.getSnapshot().preferences.direction).toBe("rtl");
  releases.push(b.connect());
  expect(local()).toBe(newer);
  expect(tab().getSnapshot()).toEqual(a.getSnapshot());
  // A request seed can never resurrect a lost last copy.
  cleanupStores();
  expect(tab({ initialRecord }).getSnapshot().preferences).toEqual({});
  expect(local()).toBeNull();
});
it("E12/E15/E16 reconciles whole records on pageshow and only visible visibilitychange", () => {
  const manager = tab();
  const a = raw(5, { direction: "rtl" });
  const b = raw(5, { reducedMotion: "full" });
  localStorage.setItem(key, a);
  writeVisualCookie(window, b);
  restore();
  expect(local()).toBe(b);
  expect(cookie()).toBe(b);
  localStorage.setItem(key, raw(6, {}));
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.getSnapshot().preferences).toEqual({ reducedMotion: "full" });
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.getSnapshot().preferences).toEqual({});
    expect(cookie()).toBe(local());
  } finally {
    visibility.mockRestore();
  }
});
it.each(["retry", "pageshow"])("recovers local quota failure on %s without producing a new stamp", (trigger) => {
  const manager = tab();
  const setter = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    manager.actions.setDirection("rtl");
    expect(manager.getStatus().storage).toEqual({ local: "failed", cookie: "ok", native: "absent" });
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
  } finally {
    setter.mockRestore();
  }
  const target = cookie();
  if (trigger === "retry") manager.actions.retry();
  else restore();
  expect(local()).toBe(target);
  expect(manager.getStatus().storage.local).toBe("ok");
});
it.each(["access", "read"] as const)(
  "E17 distinguishes local %s failures from a full quota and probes again on restore",
  (boundary) => {
    const manager = tab();
    const fault =
      boundary === "access" ? vi.spyOn(window, "localStorage", "get") : vi.spyOn(Storage.prototype, "getItem");
    fault.mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      manager.actions.setDirection("rtl");
      expect(manager.getStatus().storage).toEqual({ local: "unavailable", cookie: "ok", native: "absent" });
      signal();
      expect(fault).toHaveBeenCalledOnce();
    } finally {
      fault.mockRestore();
    }
    restore();
    expect(manager.getStatus().storage.local).toBe("ok");
    expect(local()).toBe(cookie());
  },
);
it.each([true, false])("E19 retains other tabs' fields with local blocked and SSR=%s", (ssr) => {
  const fault = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    const a = tab(ssr ? {} : spa);
    const b = tab(ssr ? {} : spa);
    a.actions.setDirection("rtl");
    b.actions.setColorSchemePreference("dark");
    expect(b.getSnapshot().preferences).toEqual(
      ssr ? { direction: "rtl", colorScheme: "dark" } : { colorScheme: "dark" },
    );
  } finally {
    fault.mockRestore();
  }
  restore();
  expect(local()).not.toBeNull();
});
it.each(["older", "invalid", "missing", "newer"] as const)(
  "classifies %s cookie readback and re-probes the store",
  (outcome) => {
    const manager = tab();
    const newer = raw(100000, { direction: "ltr" });
    const header =
      outcome === "missing"
        ? ""
        : visualCookie.name +
          "=" +
          encodeURIComponent(outcome === "older" ? raw(0) : outcome === "invalid" ? "bad" : newer);
    vi.spyOn(Date, "now").mockReturnValue(10);
    const read = vi.fn<() => string>().mockReturnValueOnce("").mockReturnValue(header);
    const write = vi.fn<(value: string) => void>();
    Object.defineProperty(document, "cookie", { configurable: true, get: read, set: write });
    try {
      manager.actions.setDirection("rtl");
      expect(manager.getStatus().storage.cookie).toBe(
        outcome === "newer" ? "ok" : outcome === "missing" ? "unavailable" : "failed",
      );
      if (outcome === "missing") {
        signal();
        manager.actions.setDirection("ltr");
      }
      expect(read).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledOnce();
    } finally {
      Reflect.deleteProperty(document, "cookie");
    }
    if (outcome === "missing" || outcome === "newer") restore();
    else manager.actions.retry();
    expect(manager.getStatus().storage.cookie).toBe("ok");
    expect(cookie()).toBe(local());
  },
);
it("recovers a disabled cookie on explicit retry", () => {
  const manager = tab();
  const disabled = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  try {
    manager.actions.setDirection("rtl");
    expect(manager.getStatus().storage.cookie).toBe("unavailable");
  } finally {
    disabled.mockRestore();
  }
  manager.actions.retry();
  expect(cookie()).toBe(local());
  expect(manager.getStatus().storage.cookie).toBe("ok");
});
it("resolves system changes while auto and releases both media subscriptions", () => {
  const listeners = new Set<() => void>();
  let matches = false;
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return matches;
    },
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
  }));
  const manager = tab();
  matches = true;
  listeners.forEach((cb) => cb());
  expect(manager.getSnapshot().resolved).toEqual({ colorScheme: "dark", direction: "ltr", reducedMotion: true });
  expect(document.documentElement.dataset.mantineColorScheme).toBe("dark");
  expect(manager.getSnapshot().preferences).toEqual({});
  manager.actions.setColorSchemePreference("light");
  manager.actions.setReducedMotionPreference("full");
  listeners.forEach((cb) => cb());
  expect(manager.getSnapshot().resolved).toMatchObject({ colorScheme: "light", reducedMotion: false });
  releases.pop()!();
  expect(listeners.size).toBe(0);
});

function nativeSource(
  read: NonNullable<ReturnType<NativeVisualSource["connect"]>>["read"],
  push: NonNullable<ReturnType<NativeVisualSource["connect"]>>["push"],
): NativeVisualSource {
  return { connect: () => ({ read, push }), prepaint: () => undefined };
}
it("discovers the actual native bridge at connect, independently of the loader's shell", () => {
  expect(tab().getStatus().storage.native).toBe("absent");
  expect(tab({ initialShell: "desktop" }).getStatus().storage.native).toBe("unavailable");
  vi.stubGlobal("desktop", {});
  expect(tab().getStatus().storage.native).toBe("unavailable");
  const manager = tab({
    nativeSource: nativeSource(
      () => ({ record: null, pending: false }),
      async () => "ok",
    ),
  });
  expect(manager.getStatus().storage.native).toBe("ok");
});
function pushGate() {
  let resolve!: (value: "ok" | "failed") => void;
  const promise = new Promise<"ok" | "failed">((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
it("ignores late native push results from superseded operations", async () => {
  const first = pushGate();
  const second = pushGate();
  let mirror: string | null = null;
  const push = vi
    .fn<(value: string) => Promise<"ok" | "failed">>((value: string) => {
      mirror = value;
      return Promise.resolve<"ok" | "failed">("ok");
    })
    .mockImplementationOnce((value) => {
      mirror = value;
      return first.promise;
    })
    .mockImplementationOnce((value) => {
      mirror = value;
      return second.promise;
    });
  const manager = tab({ nativeSource: nativeSource(() => ({ record: mirror, pending: false }), push) });
  try {
    manager.actions.setDirection("ltr");
    manager.actions.setDirection("rtl");
    second.resolve("failed");
    await second.promise;
    expect(manager.getStatus().storage.native).toBe("failed");
    first.resolve("ok");
    await first.promise;
    expect(manager.getStatus().storage.native).toBe("failed");
  } finally {
    first.resolve("ok");
    second.resolve("ok");
  }
});
it("E20/E21 repairs from the pending native mirror and confirms it only on explicit retry", async () => {
  const value = raw(5, { direction: "rtl" });
  let pending = true;
  const push = vi.fn<(value: string) => Promise<"ok">>(async () => {
    pending = false;
    return "ok" as const;
  });
  const manager = tab({ nativeSource: nativeSource(() => ({ record: value, pending }), push) });
  expect(local()).toBe(value);
  expect(cookie()).toBe(value);
  signal();
  restore();
  expect(push).not.toHaveBeenCalled();
  expect(manager.getStatus().storage.native).toBe("failed");
  manager.actions.retry();
  await Promise.resolve();
  expect(push).toHaveBeenCalledExactlyOnceWith(value);
  expect(manager.getStatus().storage.native).toBe("ok");
});
it("re-probes native read and push transport failures without blocking the Web stores", async () => {
  const read = vi
    .fn<() => { record: null; pending: boolean }>(() => ({ record: null, pending: false }))
    .mockImplementationOnce(() => {
      throw new Error("ipc");
    });
  const push = vi
    .fn<() => Promise<Exclude<StoreStatus, "absent">>>()
    .mockRejectedValueOnce(new Error("ipc"))
    .mockResolvedValue("ok");
  const manager = tab({ nativeSource: nativeSource(read, push) });
  expect(manager.getStatus().storage.native).toBe("unavailable");
  manager.actions.setDirection("rtl");
  expect(cookie()).toBe(local());
  manager.actions.retry();
  await Promise.resolve();
  expect(manager.getStatus().storage.native).toBe("unavailable");
  restore();
  await Promise.resolve();
  expect(manager.getStatus().storage.native).toBe("ok");
});

it.each([
  ["D1", false, false, false],
  ["D2", true, false, false],
  ["D3", false, true, false],
  ["D4", false, false, true],
  ["D5", true, true, false],
  ["D6", true, false, true],
  ["D7", false, true, true],
  ["D8", true, true, true],
] as const)(
  "%s preserves successful writes and retries the same record across independent failures",
  async (_, failLocal, failCookie, failNative) => {
    const old = raw(1, { direction: "ltr" });
    localStorage.setItem(key, old);
    writeVisualCookie(window, old);
    let mirror = old;
    let pending = false;
    let diskFault = failNative;
    const push = vi.fn<(value: string) => Promise<"ok" | "failed">>(async (value: string) => {
      mirror = value;
      pending = diskFault;
      return pending ? ("failed" as const) : ("ok" as const);
    });
    const adapter = nativeSource(() => ({ record: mirror, pending }), push);
    const manager = tab({ nativeSource: adapter });
    const localFault = failLocal
      ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
          throw new Error("quota");
        })
      : undefined;
    const cookieFault = failCookie ? vi.spyOn(document, "cookie", "set").mockImplementation(() => {}) : undefined;
    try {
      manager.actions.setDirection("rtl");
      await Promise.resolve();
      expect(manager.getSnapshot().preferences.direction).toBe("rtl");
      expect(manager.getStatus().storage).toEqual({
        local: failLocal ? "failed" : "ok",
        cookie: failCookie ? "failed" : "ok",
        native: failNative ? "failed" : "ok",
      });
      expect(local()).toBe(failLocal ? old : mirror);
      expect(cookie()).toBe(failCookie ? old : mirror);
      // A refresh still sees main's in-memory record, even when every durable write failed.
      const refreshed = tab({ nativeSource: adapter });
      expect(refreshed.getSnapshot().preferences.direction).toBe("rtl");
      expect(refreshed.getStatus().storage.native).toBe(failNative ? "failed" : "ok");
      expect(push).toHaveBeenCalledTimes(1);
    } finally {
      localFault?.mockRestore();
      cookieFault?.mockRestore();
      diskFault = false;
    }
    const original = mirror;
    manager.actions.retry();
    await Promise.resolve();
    expect(manager.getStatus().storage).toEqual({ local: "ok", cookie: "ok", native: "ok" });
    expect([local(), cookie(), mirror]).toEqual([original, original, original]);
  },
);
