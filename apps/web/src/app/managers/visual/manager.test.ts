import { visualRecordKernel as records, type VisualPreferences } from "@repo/shared";
import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from "vitest";

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
function signal(newValue: string | null = null) {
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
}
function restore() {
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
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

it.each(["missing", "invalid", "divergent"])("E11/E18 interleave two connects with %s replicas", (scenario) => {
  const divergent = scenario === "divergent";
  const winner = raw(1, { direction: "rtl" });
  if (divergent) {
    localStorage.setItem(key, raw(2, { reducedMotion: "full" }));
    writeVisualCookie(window, winner);
  } else if (scenario === "invalid") localStorage.setItem(key, "{}");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const writeCookie = vi.spyOn(document, "cookie", "set");
  const second = createVisualManager({ host: window });
  // Finish the second connect while the first is observing the cookie.
  const header = document.cookie;
  const gate = vi.spyOn(document, "cookie", "get").mockImplementationOnce(() => {
    releases.push(second.connect());
    return header;
  });
  try {
    const first = tab();
    expect(second.getStatus().initialized).toBe(true);
    expect(first.getSnapshot()).toEqual(second.getSnapshot());
    expect(first.getSnapshot().preferences).toEqual(divergent ? { direction: "rtl" } : {});
    expect(local()).toBe(divergent ? winner : scenario === "invalid" ? "{}" : null);
    expect(cookie()).toBe(divergent ? winner : null);
    signal();
    restore();
    first.actions.retry();
    expect(write).toHaveBeenCalledTimes(divergent ? 1 : 0);
    expect(writeCookie).not.toHaveBeenCalled();
  } finally {
    gate.mockRestore();
  }
});

it("replaces a poisoned upstream replica and keeps setters and reset usable", () => {
  writeVisualCookie(window, raw(Number.MAX_SAFE_INTEGER));
  const good = raw(10, { direction: "rtl" });
  localStorage.setItem(key, good);
  const manager = tab();
  expect(cookie()).toBe(good);
  manager.actions.setColorSchemePreference("dark");
  expect(manager.getSnapshot().preferences).toEqual({ direction: "rtl", colorScheme: "dark" });
  manager.actions.resetVisualPreferences();
  expect(records.decode(cookie()).record?.preferences).toEqual({});
  expect(local()).toBe(cookie());
});

it("advances past a higher timestamp even after start rolls local storage back", () => {
  const upstream = raw(10, { colorScheme: "light" });
  writeVisualCookie(window, upstream);
  localStorage.setItem(key, raw(100, { colorScheme: "dark" }));
  vi.spyOn(Date, "now").mockReturnValue(20);
  const manager = tab();
  expect(local()).toBe(upstream);
  manager.actions.setDirection("rtl");
  expect(records.decode(local()).record).toMatchObject({
    stamp: { t: 101 },
    preferences: { colorScheme: "light", direction: "rtl" },
  });
});

it("ignores retry before the first connection and preserves startup priority", () => {
  const upstream = raw(1, { direction: "rtl" });
  writeVisualCookie(window, upstream);
  localStorage.setItem(key, raw(2));
  const manager = createVisualManager({ host: window });
  const read = vi.spyOn(Storage.prototype, "getItem");
  manager.actions.retry();
  expect(read).not.toHaveBeenCalled();
  expect(manager.getStatus().initialized).toBe(false);
  releases.push(manager.connect());
  expect([cookie(), local()]).toEqual([upstream, upstream]);
});

it("applies document attributes on attach with unchanged state and no prepaint", () => {
  const manager = createVisualManager({ host: window });
  const before = manager.getSnapshot();
  const root = document.documentElement;
  root.removeAttribute("dir");
  releases.push(manager.connect());
  expect(manager.getSnapshot()).toBe(before);
  expect(root.dir).toBe(before.resolved.direction);
});

it("performs no replica I/O on the initial pageshow", () => {
  const read = vi.fn<NativeBridge["read"]>(() => ({ record: null, pending: false }));
  const push = vi.fn<() => Promise<"ok">>();
  tab({ nativeSource: nativeSource(read, push) });
  read.mockClear();
  const localRead = vi.spyOn(Storage.prototype, "getItem");
  const localWrite = vi.spyOn(Storage.prototype, "setItem");
  const cookieRead = vi.spyOn(document, "cookie", "get");
  const cookieWrite = vi.spyOn(document, "cookie", "set");
  window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
  for (const operation of [read, push, localRead, localWrite, cookieRead, cookieWrite]) {
    expect(operation).not.toHaveBeenCalled();
  }
});

it("requires an exact cookie read-back at start and keeps the upstream winner", () => {
  const upstream = raw(1, { direction: "rtl" });
  const newer = raw(2, { colorScheme: "dark" });
  const gate = vi.spyOn(document, "cookie", "set").mockImplementationOnce(() => writeVisualCookie(window, newer));
  let manager;
  try {
    manager = tab({
      nativeSource: nativeSource(
        () => ({ record: upstream, pending: false }),
        async () => "ok",
      ),
    });
    expect(cookie()).toBe(newer);
    expect(manager.getStatus().storage.cookie).toBe("failed");
    expect(manager.getSnapshot().preferences).toEqual({ direction: "rtl" });
    expect(local()).toBe(upstream);
  } finally {
    gate.mockRestore();
  }
  manager.actions.retry();
  expect(manager.getStatus().storage.cookie).toBe("ok");
  expect(local()).toBe(newer);
});

it("classifies a malformed cookie escape as invalid and repairs it on retry", () => {
  document.cookie = visualCookie.name + "=%ZZ; Path=/";
  expect(cookie()).toBe("");
  const value = raw(1, { direction: "rtl" });
  localStorage.setItem(key, value);
  const blocked = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  let manager;
  try {
    manager = tab();
    expect(manager.getStatus().storage.cookie).toBe("failed");
  } finally {
    blocked.mockRestore();
  }
  manager.actions.retry();
  expect(cookie()).toBe(value);
  expect(manager.getStatus().storage.cookie).toBe("ok");
});

it("resets individual direction and motion choices and stamps even a repeated whole reset", () => {
  const manager = tab();
  manager.actions.setDirection("rtl");
  manager.actions.setReducedMotionPreference("reduce");
  manager.actions.resetReducedMotionPreference();
  expect(records.decode(local()).record?.preferences).toEqual({ direction: "rtl" });
  manager.actions.resetDirection();
  const empty = records.decode(local()).record!;
  expect(empty.preferences).toEqual({});
  manager.actions.resetVisualPreferences();
  expect(records.decode(local()).record!.stamp.t).toBeGreaterThan(empty.stamp.t);
  expect(cookie()).toBe(local());
});
it("A2 preserves an invalid SPA record until the first user edit and never touches the cookie", () => {
  localStorage.setItem(key, "{}");
  const getCookie = vi.spyOn(document, "cookie", "get");
  const setCookie = vi.spyOn(document, "cookie", "set");
  const write = vi.spyOn(Storage.prototype, "setItem");
  const manager = tab(spa);
  expect(manager.getSnapshot().preferences).toEqual({});
  expect(local()).toBe("{}");
  expect(write).not.toHaveBeenCalled();
  manager.actions.setDirection("rtl");
  expect(write).toHaveBeenCalledOnce();
  expect(records.decode(local()).record?.preferences).toEqual({ direction: "rtl" });
  expect(getCookie).not.toHaveBeenCalled();
  expect(setCookie).not.toHaveBeenCalled();
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
  signal("{}");
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
    const manager = tab();
    const old = raw(1, { direction: "rtl" });
    const newer = raw(2, { direction: "ltr" });
    if (store === "local") {
      writeVisualCookie(window, old);
      localStorage.setItem(key, newer);
      vi.spyOn(Storage.prototype, "getItem").mockReturnValueOnce(null);
    } else {
      localStorage.setItem(key, old);
      writeVisualCookie(window, newer);
      vi.spyOn(document, "cookie", "get").mockReturnValueOnce("");
    }
    const write = vi.spyOn(Storage.prototype, "setItem");
    const setCookie = vi.spyOn(document, "cookie", "set");
    restore();
    expect(local()).toBe(newer);
    expect(cookie()).toBe(newer);
    expect(write).toHaveBeenCalledTimes(store === "local" ? 0 : 1);
    expect(setCookie).toHaveBeenCalledTimes(store === "local" ? 1 : 0);
    expect(manager.getSnapshot().preferences).toEqual({ direction: "ltr" });
    restore();
    expect(manager.getSnapshot().preferences).toEqual({ direction: "ltr" });
  },
);
it("E2 converges after two overlapping non-empty field edits based on the same snapshot", () => {
  const a = tab();
  const b = tab();
  const now = vi.spyOn(Date, "now").mockReturnValue(10);
  const writes = vi.spyOn(Storage.prototype, "setItem");
  const oldLocal = local();
  // B already sampled the cookie. A completes both writes before B finishes its local read.
  const gate = vi.spyOn(Storage.prototype, "getItem").mockImplementationOnce(() => {
    a.actions.setDirection("rtl");
    now.mockReturnValue(11);
    return oldLocal;
  });
  try {
    b.actions.setReducedMotionPreference("reduce");
    const commits = writes.mock.calls.map(([, value]) => records.decode(value).record);
    expect(commits).toMatchObject([
      { stamp: { t: 10 }, preferences: { direction: "rtl" } },
      { stamp: { t: 11 }, preferences: { reducedMotion: "reduce" } },
    ]);
    expect(a.getSnapshot().preferences).toEqual({ direction: "rtl" });
    expect(b.getSnapshot().preferences).toEqual({ reducedMotion: "reduce" });
    const winner = writes.mock.calls[1][1];
    signal();
    expect(a.getSnapshot().preferences).toEqual({ reducedMotion: "reduce" });
    expect(a.getSnapshot()).toEqual(b.getSnapshot());
    expect([local(), cookie()]).toEqual([winner, winner]);
    expect(writes).toHaveBeenCalledTimes(2);
  } finally {
    gate.mockRestore();
  }
});

it.each([true, false])(
  "E14 simultaneous reset and field edit converge when winner remains observable: %s",
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
it.each(["local", "memory"])("E3/E4 starts from the stale cookie when a newer edit survives in %s", (survivor) => {
  const a = tab();
  const closeA = releases.at(-1)!;
  a.actions.setDirection("rtl");
  const old = cookie()!;
  document.cookie = visualCookie.name + "=; Max-Age=0; Path=/";
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.set!.bind(document);
  const gate = vi.spyOn(document, "cookie", "set").mockImplementationOnce((value) => {
    a.actions.setColorSchemePreference("dark");
    setter(value);
  });
  try {
    tab(); // B resumes its pending repair after A commits.
    releases.pop()!();
    const current = local()!;
    expect(records.decode(current).record?.preferences).toEqual({ direction: "rtl", colorScheme: "dark" });
    expect(cookie()).toBe(old);
    if (survivor === "local") closeA();
    else localStorage.setItem(key, old);
    const observable = records.decode(old).record!;
    window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window);
    expect(window.frameworkVisualBootstrap.record).toEqual(observable);
    const reopened = tab();
    expect(reopened.getSnapshot().preferences).toEqual(observable.preferences);
    if (survivor === "memory") restore();
    const expected = survivor === "memory" ? current : old;
    expect(reopened.getSnapshot().preferences).toEqual(records.decode(expected).record!.preferences);
    expect([local(), cookie()]).toEqual([expected, expected]);
  } finally {
    gate.mockRestore();
  }
});

function interruptBackfill(ssr: boolean) {
  const old = raw(1, { direction: "rtl" });
  localStorage.setItem(key, old);
  const b = tab(ssr ? {} : spa);
  const closeB = releases.at(-1)!;
  // A writes only local storage, so its queued event carries the last copy of the edit.
  const a = tab(spa);
  const closeA = releases.at(-1)!;
  localStorage.removeItem(key);
  let lastReplica: string | null = null;
  const write = localStorage.setItem.bind(localStorage);
  const gate = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce((k, v) => {
    a.actions.setColorSchemePreference("dark");
    lastReplica = local();
    closeA();
    write(k, v);
  });
  try {
    signal();
    const winner = records.decode(lastReplica).record!;
    expect(winner.preferences).toEqual({ direction: "rtl", colorScheme: "dark" });
    expect(winner.stamp.t).toBeGreaterThan(1);
    expect(local()).toBe(old);
    expect(cookie()).toBe(ssr ? old : null);
    return { b, closeB, old, edit: lastReplica! };
  } finally {
    gate.mockRestore();
  }
}
it.each([false, true])("E3 recovers the closed writer's edit from its storage event with SSR=%s", (ssr) => {
  const { b, old, edit } = interruptBackfill(ssr);
  const write = vi.spyOn(Storage.prototype, "setItem");
  const setCookie = vi.spyOn(document, "cookie", "set");
  signal(edit);
  expect(local()).toBe(edit);
  expect(cookie()).toBe(ssr ? edit : null);
  expect(b.getSnapshot().preferences).toEqual({ direction: "rtl", colorScheme: "dark" });
  signal(old);
  signal(edit);
  expect(write).toHaveBeenCalledExactlyOnceWith(key, edit);
  expect(setCookie).toHaveBeenCalledTimes(Number(ssr));
});
it("E3 loses the edit when both SPA tabs close before the writer's storage event is handled", () => {
  const { closeB, old, edit } = interruptBackfill(false);
  closeB();
  signal(edit);
  expect(tab(spa).getSnapshot().preferences).toEqual({ direction: "rtl" });
  expect(local()).toBe(old);
});
it("E5/E6 keeps a stale request seed out of live selection and new tabs agree before any event", () => {
  const original = raw(1, { direction: "ltr" });
  writeVisualCookie(window, original);
  const initialRecord = records.decode(cookie()).record;
  const a = tab();
  a.actions.setDirection("rtl");
  const newer = cookie()!;
  releases.pop()!(); // Refresh immediately after the command, before any storage event.
  expect(tab().getSnapshot().preferences).toEqual({ direction: "rtl" });
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
  const peer = tab();
  peer.actions.resetVisualPreferences();
  const newest = local();
  writeVisualCookie(window, b);
  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  try {
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.getSnapshot().preferences).toEqual({ reducedMotion: "full" });
    expect(cookie()).toBe(b);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(manager.getSnapshot().preferences).toEqual({});
    expect(cookie()).toBe(newest);
    localStorage.setItem(key, a); // Manual regression to an older stamp.
    restore();
    expect([local(), cookie()]).toEqual([newest, newest]);
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
  document.cookie = visualCookie.name + "=; Max-Age=0; Path=/";
  if (trigger === "retry") manager.actions.retry();
  else restore();
  expect(cookie()).toBe(target);
  expect(local()).toBe(target);
  expect(manager.getStatus().storage.local).toBe("ok");
});
it.each([
  ["access", "retry"],
  ["read", "pageshow"],
] as const)("E17 distinguishes local %s failure from a full quota and probes again on %s", (boundary, trigger) => {
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
  if (trigger === "retry") manager.actions.retry();
  else restore();
  expect(manager.getStatus().storage.local).toBe("ok");
  expect(local()).toBe(cookie());
});
it.each([true, false])("E19 retains other tabs' fields with local blocked and SSR=%s", (ssr) => {
  const fault = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    const a = tab(ssr ? {} : spa);
    const b = tab(ssr ? {} : spa);
    a.actions.setDirection("rtl");
    b.actions.setColorSchemePreference("dark");
    expect(a.getSnapshot().preferences).toEqual({ direction: "rtl" });
    expect(a.getStatus().storage.local).toBe("unavailable");
    expect(b.getStatus().storage.local).toBe("unavailable");
    expect(records.decode(cookie()).record?.preferences).toEqual(
      ssr ? { direction: "rtl", colorScheme: "dark" } : undefined,
    );
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
it("applies the connected manager's appearance to the document", () => {
  expectTypeOf<NonNullable<Parameters<typeof createVisualManager>[0]>>().not.toHaveProperty("applyToDocument");
  localStorage.setItem(key, raw(1, { direction: "rtl" }));
  const manager = tab();
  expect(document.documentElement.dir).toBe("rtl");
  manager.actions.setDirection("ltr");
  expect(document.documentElement.dir).toBe("ltr");
});
it("resolves system changes while auto and releases both media subscriptions", () => {
  const dark = { matches: false, listeners: new Set<() => void>() };
  const motion = { matches: false, listeners: new Set<() => void>() };
  vi.stubGlobal("matchMedia", (query: string) => {
    const media =
      query === "(prefers-color-scheme: dark)"
        ? dark
        : query === "(prefers-reduced-motion: reduce)"
          ? motion
          : undefined;
    if (!media) throw new Error("Unexpected media query: " + query);
    return {
      get matches() {
        return media.matches;
      },
      addEventListener: (_: string, cb: () => void) => media.listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => media.listeners.delete(cb),
    };
  });
  const manager = tab();
  function toggle(media: typeof dark) {
    media.matches = !media.matches;
    media.listeners.forEach((cb) => cb());
  }
  function resolved(colorScheme: "light" | "dark", reducedMotion: boolean) {
    expect(manager.getSnapshot().resolved).toEqual({ colorScheme, direction: "ltr", reducedMotion });
  }
  resolved("light", false);
  toggle(dark);
  resolved("dark", false);
  toggle(motion);
  resolved("dark", true);
  expect(manager.getSnapshot().preferences).toEqual({});
  manager.actions.setColorSchemePreference("light");
  toggle(motion);
  resolved("light", false);
  toggle(motion);
  resolved("light", true);
  manager.actions.setReducedMotionPreference("full");
  resolved("light", false);
  toggle(dark);
  toggle(motion);
  resolved("light", false);
  manager.actions.setColorSchemePreference("dark");
  manager.actions.setReducedMotionPreference("reduce");
  resolved("dark", true);
  toggle(dark);
  toggle(motion);
  toggle(dark);
  toggle(motion);
  resolved("dark", true);
  releases.pop()!();
  expect(dark.listeners.size).toBe(0);
  expect(motion.listeners.size).toBe(0);
});

it("loses a Web-only edit on refresh when both writes fail", () => {
  const saved = raw(1, { direction: "ltr" });
  localStorage.setItem(key, saved);
  writeVisualCookie(window, saved);
  const manager = tab();
  const localFault = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const cookieFault = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  try {
    manager.actions.setDirection("rtl");
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
    expect(manager.getStatus().storage).toEqual({ local: "failed", cookie: "failed", native: "absent" });
    releases.pop()!();
  } finally {
    localFault.mockRestore();
    cookieFault.mockRestore();
  }
  const refreshed = tab();
  expect(refreshed.getSnapshot().preferences.direction).toBe("ltr");
  refreshed.actions.setDirection("rtl");
  expect(refreshed.getStatus().storage).toEqual({ local: "ok", cookie: "ok", native: "absent" });
  expect(tab().getSnapshot().preferences.direction).toBe("rtl");
});

type NativeBridge = NonNullable<ReturnType<NativeVisualSource["connect"]>>;

function nativeSource(read: NativeBridge["read"], push: NativeBridge["push"]): NativeVisualSource {
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
it.each([true, false])("publishes live fixed appearance on connect and retry (prepaint handoff: %s)", (handoff) => {
  let fixedAppearance: "dark" | "light" | undefined = "dark";
  const adapter = nativeSource(
    () => ({ record: null, pending: false, fixedAppearance }),
    async () => "ok",
  );
  const prepaint = vi.spyOn(adapter, "prepaint");
  if (handoff) window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window, adapter.prepaint);
  const manager = createVisualManager({ host: window, nativeSource: adapter });
  const listener = vi.fn<() => "dark" | "light">(() => manager.getSnapshot().resolved.colorScheme);
  releases.push(manager.subscribe(listener));
  releases.push(manager.connect());
  expect(listener).toHaveLastReturnedWith("dark");
  fixedAppearance = "light";
  manager.actions.retry();
  expect(listener).toHaveLastReturnedWith("light");
  fixedAppearance = undefined;
  manager.actions.retry();
  expect(manager.fixedAppearance).toBeUndefined();
  expect(listener).toHaveBeenCalledTimes(3);
  expect(prepaint).toHaveBeenCalledTimes(handoff ? 1 : 0);
});

it.each(["ok", "failed"] as const)(
  "adopts the native record recovered during a stale push returning %s",
  async (result) => {
    const older = raw(1, { direction: "ltr" });
    const newer = raw(2, { direction: "rtl" });
    writeVisualCookie(window, older);
    localStorage.setItem(key, older);
    const reply = pushGate();
    let mirror: string | null = null;
    const read = vi.fn<NativeBridge["read"]>(() => ({ record: mirror, pending: !mirror || result === "failed" }));
    const push = vi.fn<NativeBridge["push"]>(() => reply.promise);
    const manager = tab({ nativeSource: nativeSource(read, push) });
    expect(manager.getSnapshot().preferences.direction).toBe("ltr");
    mirror = newer;
    reply.resolve(result);
    await reply.promise;
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
    expect([cookie(), local()]).toEqual([newer, newer]);
    expect(manager.getStatus().storage.native).toBe(result);
    expect(read).toHaveBeenCalledTimes(2);
    expect(push).toHaveBeenCalledExactlyOnceWith(older);
  },
);

it("does not repeat a failed push while the mirror remains unreadable", async () => {
  const value = raw(1);
  localStorage.setItem(key, value);
  const reply = pushGate();
  const read = vi.fn<NativeBridge["read"]>(() => ({ record: null, pending: true }));
  const push = vi.fn<NativeBridge["push"]>().mockReturnValueOnce(reply.promise).mockReturnValue(pushGate().promise);
  const manager = tab({ nativeSource: nativeSource(read, push) });
  reply.resolve("failed");
  await reply.promise;
  expect(read).toHaveBeenCalledTimes(2);
  expect(push).toHaveBeenCalledExactlyOnceWith(value);
  expect(manager.getStatus().storage.native).toBe("failed");
});

it("retires the pending push on last disconnect", async () => {
  const reply = pushGate();
  const read = vi.fn<NativeBridge["read"]>(() => ({ record: null, pending: true }));
  const manager = tab({ nativeSource: nativeSource(read, () => reply.promise) });
  manager.actions.setDirection("rtl");
  releases.pop()!();
  const listener = vi.fn<() => void>();
  releases.push(manager.subscribeStatus(listener));
  read.mockClear().mockReturnValue({ record: null, pending: false });
  reply.resolve("ok");
  await reply.promise;
  expect(read).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  expect(manager.getStatus().storage.native).toBe("failed");
});

it("ignores late native push results from superseded operations", async () => {
  const first = pushGate();
  const second = pushGate();
  let pending = false;
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
  const manager = tab({ nativeSource: nativeSource(() => ({ record: mirror, pending }), push) });
  try {
    manager.actions.setDirection("ltr");
    manager.actions.setDirection("rtl");
    pending = true;
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
it("keeps a restored native confirmation when the original failed push replies late", async () => {
  const reply = pushGate();
  let mirror: string | null = null;
  let pending = false;
  const push = vi.fn<(value: string) => typeof reply.promise>((value) => {
    mirror = value;
    pending = true;
    return reply.promise;
  });
  const manager = tab({ nativeSource: nativeSource(() => ({ record: mirror, pending }), push) });
  try {
    manager.actions.setDirection("rtl");
    // Main retries the pending write before the original IPC reply reaches this window.
    pending = false;
    restore();
    expect(push).toHaveBeenCalledExactlyOnceWith(local());
    expect(manager.getStatus().storage.native).toBe("ok");
    reply.resolve("failed");
    await reply.promise;
    expect(manager.getStatus().storage.native).toBe("ok");
  } finally {
    reply.resolve("failed");
  }
});
it("E20/E21 repairs from the pending native mirror and confirms it only on explicit retry", async () => {
  const value = raw(5, { direction: "rtl" });
  localStorage.setItem(key, raw(3, { direction: "ltr" }));
  writeVisualCookie(window, raw(2, { colorScheme: "light" }));
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

it.each([
  ["E8 cold restart", "native", "newer", "newer", "native"],
  ["cleared Web storage", "native", null, null, "native"],
  ["missing cookie", null, null, "newer", "newer"],
  ["invalid native and cookie", "invalid", "invalid", "newer", "newer"],
  ["invalid native", "invalid", "cookie", "newer", "cookie"],
  ["matching cookie", "native", "native", "newer", "native"],
  ["matching local", "native", null, "native", "native"],
  ["matching Web replicas", null, "cookie", "cookie", "cookie"],
  ["all replicas equal", "native", "native", "native", "native"],
  ["first launch", null, null, null, null],
] as const)(
  "starts from the first valid replica and repairs its peers after %s",
  (_, nativeValue, cookieValue, localValue, expected) => {
    const wires = {
      native: raw(1, { direction: "rtl" }),
      cookie: raw(2, { colorScheme: "dark" }),
      newer: raw(3, { reducedMotion: "full" }),
      invalid: "{}",
    };
    let mirror = nativeValue && wires[nativeValue];
    if (cookieValue) writeVisualCookie(window, wires[cookieValue]);
    if (localValue) localStorage.setItem(key, wires[localValue]);
    const push = vi.fn<(value: string) => Promise<"ok">>(async (value) => {
      mirror = value;
      return "ok";
    });
    const adapter = nativeSource(() => ({ record: mirror, pending: false }), push);
    adapter.prepaint = () => ({ record: mirror });
    const winner = expected && wires[expected];
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(document, "cookie", "set");
    window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window, adapter.prepaint);
    expect(window.frameworkVisualBootstrap.record).toEqual(records.decode(winner).record);
    const manager = tab({ nativeSource: adapter });
    expect(manager.getSnapshot().preferences).toEqual(records.decode(winner).record?.preferences ?? {});
    expect([mirror, cookie(), local()]).toEqual([winner, winner, winner]);
    expect(push).toHaveBeenCalledTimes(Number(nativeValue !== expected));
    expect(cookieWrite).toHaveBeenCalledTimes(Number(cookieValue !== expected));
    expect(localWrite).toHaveBeenCalledTimes(Number(localValue !== expected));
  },
);

it.each([true, false])("rolls back a failed cookie write at start, with the writer still open: %s", (open) => {
  const old = raw(1, { direction: "ltr" });
  writeVisualCookie(window, old);
  const writer = tab();
  const fault = vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  try {
    writer.actions.setDirection("rtl");
    expect(writer.getStatus().storage.cookie).toBe("failed");
  } finally {
    fault.mockRestore();
  }
  const edit = local();
  if (!open) releases.pop()!();
  window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window);
  expect(window.frameworkVisualBootstrap.record).toEqual(records.decode(old).record);
  const reader = tab();
  expect(reader.getSnapshot().preferences.direction).toBe("ltr");
  expect(local()).toBe(old);
  signal();
  expect(reader.getSnapshot().preferences.direction).toBe(open ? "rtl" : "ltr");
  expect([local(), cookie()]).toEqual(open ? [edit, edit] : [old, old]);
});

it.each([null, raw(1, { direction: "ltr" })])(
  "first connect re-reads all stores after prepaint (cookie %s)",
  (current) => {
    const stale = raw(2, { direction: "rtl" });
    localStorage.setItem(key, stale);
    window.frameworkVisualBootstrap = visualCodec.read(visualBootstrapConfig, window);
    const manager = createVisualManager({ host: window });
    expect(manager.getSnapshot().preferences.direction).toBe("rtl");
    localStorage.clear();
    if (current) writeVisualCookie(window, current);
    releases.push(manager.connect());
    expect(manager.getSnapshot().preferences).toEqual(records.decode(current).record?.preferences ?? {});
    expect([cookie(), local()]).toEqual([current, current]);
  },
);

it("preserves a command before first connect and uses runtime ordering on reconnect", () => {
  const old = raw(1, { direction: "rtl" });
  writeVisualCookie(window, old);
  localStorage.setItem(key, raw(2, { reducedMotion: "reduce" }));
  const manager = createVisualManager({ host: window });
  manager.actions.setColorSchemePreference("dark");
  const edit = local();
  expect(records.decode(edit).record?.preferences).toEqual({ colorScheme: "dark", reducedMotion: "reduce" });
  for (let i = 0; i < 2; i++) {
    writeVisualCookie(window, old);
    localStorage.removeItem(key);
    const disconnect = manager.connect();
    try {
      expect([cookie(), local()]).toEqual([edit, edit]);
      expect(manager.getSnapshot().preferences).toEqual(records.decode(edit).record!.preferences);
    } finally {
      disconnect();
    }
  }
});

it("writes native, cookie, then local and propagates a newer cookie readback to every replica", () => {
  let mirror: string | null = null;
  const push = vi.fn<(value: string) => Promise<"ok">>(async (value) => {
    mirror = value;
    return "ok";
  });
  const a = tab({ nativeSource: nativeSource(() => ({ record: mirror, pending: false }), push) });
  const peer = tab();
  const setter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.set!.bind(document);
  const write = vi.spyOn(Storage.prototype, "setItem");
  const gate = vi.spyOn(document, "cookie", "set").mockImplementationOnce((value) => {
    setter(value);
    write.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    peer.actions.setDirection("rtl");
  });
  try {
    a.actions.setColorSchemePreference("dark");
    expect(peer.getStatus().storage.local).toBe("failed");
    const winner = cookie();
    expect(records.decode(winner).record?.preferences).toEqual({ direction: "rtl", colorScheme: "dark" });
    expect(a.getSnapshot()).toEqual(peer.getSnapshot());
    expect([mirror, local()]).toEqual([winner, winner]);
    expect(push.mock.invocationCallOrder[0]).toBeLessThan(gate.mock.invocationCallOrder[0]);
    expect(gate.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]);
  } finally {
    gate.mockRestore();
    write.mockRestore();
  }
  peer.actions.retry();
  expect(peer.getStatus().storage.local).toBe("ok");
  expect(local()).toBe(cookie());
});

it("keeps an equal pending native retry live across pageshow", async () => {
  const reply = pushGate();
  const value = raw(1, { direction: "rtl" });
  let pending = true;
  const push = vi.fn<() => typeof reply.promise>(() => reply.promise);
  const manager = tab({ nativeSource: nativeSource(() => ({ record: value, pending }), push) });
  try {
    manager.actions.retry();
    restore();
    expect(push).toHaveBeenCalledExactlyOnceWith(value);
    expect(manager.getStatus().storage.native).toBe("failed");
    pending = false;
    reply.resolve("ok");
    await reply.promise;
    expect(manager.getStatus().storage.native).toBe("ok");
  } finally {
    reply.resolve("ok");
  }
});

it.each([false, true])("invalidates a push after a native read failure (rediscovery: %s)", async (rediscover) => {
  const reply = pushGate();
  const read = vi.fn<() => { record: string | null; pending: boolean }>(() => ({ record: local(), pending: false }));
  const adapter = nativeSource(read, () => reply.promise);
  const manager = tab({ initialShell: "desktop", nativeSource: adapter });
  const discovery = vi.spyOn(adapter, "connect");
  try {
    manager.actions.setDirection("rtl");
    read.mockImplementationOnce(() => {
      throw new Error("ipc");
    });
    restore();
    if (rediscover) {
      discovery.mockReturnValueOnce(undefined);
      manager.actions.retry();
    }
    expect(manager.getStatus().storage.native).toBe("unavailable");
    reply.resolve("ok");
    await reply.promise;
    expect(manager.getStatus().storage.native).toBe("unavailable");
  } finally {
    discovery.mockRestore();
    reply.resolve("ok");
  }
  manager.actions.retry();
  expect(manager.getStatus().storage.native).toBe("ok");
});

it("first connection retires the pre-connect push when it rediscovers the bridge", async () => {
  const reply = pushGate();
  let pending = true;
  let mirror: string | null = null;
  const adapter = nativeSource(
    () => ({ record: mirror, pending }),
    (value) => {
      mirror = value;
      return reply.promise;
    },
  );
  const manager = createVisualManager({ host: window, nativeSource: adapter });
  try {
    manager.actions.setDirection("rtl");
    releases.push(manager.connect());
    expect(manager.getStatus().storage.native).toBe("failed");
    reply.resolve("ok");
    await reply.promise;
    expect(manager.getStatus().storage.native).toBe("failed");
    manager.actions.retry();
    pending = false;
    await reply.promise;
    expect(manager.getStatus().storage.native).toBe("ok");
  } finally {
    reply.resolve("ok");
  }
});
