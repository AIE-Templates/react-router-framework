import { afterEach, expect, it, vi } from "vitest";

import { CookieWorkerManager, type WakeRecord } from "../main/sw/cookie-worker-manager.ts";
import { installSubscriptionShims } from "./subscriptions.ts";

const scope = "app://app/area/";

function setup(initial: readonly WakeRecord[] = [{ scope, name: "x", eligible: true, since: 0 }]) {
  const native = {
    subscribe: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unsubscribe: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    unregister: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
  };
  class Cookies {
    subscribe(_subscriptions: CookieStoreGetOptions[]) {
      return native.subscribe();
    }
    unsubscribe(_subscriptions: CookieStoreGetOptions[]) {
      return native.unsubscribe();
    }
  }
  class Registration {
    readonly #cookies = new Cookies();
    get cookies() {
      return this.#cookies;
    }
    get scope() {
      return scope;
    }
    unregister() {
      return native.unregister();
    }
  }
  vi.stubGlobal("CookieStoreManager", Cookies);
  vi.stubGlobal("ServiceWorkerRegistration", Registration);
  let disk = initial;
  const write = vi.fn<(records: readonly WakeRecord[]) => Promise<void>>(async (records) => {
    disk = records;
  });
  const warn = vi.fn<() => void>();
  const manager = new CookieWorkerManager({
    storage: { read: () => disk, write },
    logger: { warn },
    scheduler: {
      now: Date.now,
      after: (ms, callback) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
    native: { startWorkerForScope: async () => null },
  });
  installSubscriptionShims({
    async acquire(target, operation) {
      try {
        return await manager.acquire(target, operation, "frame");
      } catch (err) {
        // ipcRenderer.invoke transports a main-process exception as a plain Error.
        throw new Error("Error invoking remote method 'acquire': " + String(err), { cause: err });
      }
    },
    complete: (id, success) => manager.complete(id, success, "frame"),
  });
  return { registration: new Registration(), native, write, warn, disk: () => disk, manager };
}

afterEach(() => vi.unstubAllGlobals());

it.each(["unregister", "unsubscribe"] as const)(
  "preserves the native %s result when completion persistence fails",
  async (kind) => {
    const h = setup();
    try {
      h.write.mockRejectedValueOnce(new Error("ENOSPC"));
      const result =
        kind === "unregister"
          ? await h.registration.unregister()
          : await h.registration.cookies.unsubscribe([{ name: "x" }]);
      expect(result).toBe(kind === "unregister" ? true : undefined);
      expect(h.native[kind]).toHaveBeenCalledOnce();
      expect(h.warn).toHaveBeenCalledOnce();
      expect(h.write).toHaveBeenCalledTimes(2);
      expect(h.disk()).toEqual([]);
      await h.registration.cookies.subscribe([{ name: "y" }]);
      expect(h.disk().map((r) => r.name)).toEqual(["y"]);
    } finally {
      await h.manager.quitAll();
    }
  },
);

it("allows native unsubscribe and unregister on an unindexed scope at capacity", async () => {
  const h = setup(Array.from({ length: 128 }, (_, i) => ({ scope: scope + i, eligible: true, since: 0 })));
  try {
    await h.registration.cookies.unsubscribe(Array.from({ length: 129 }, () => ({ name: "x".repeat(4097) })));
    expect(h.native.unsubscribe).toHaveBeenCalledOnce();
    await expect(h.registration.unregister()).resolves.toBe(true);
    expect(h.native.unregister).toHaveBeenCalledOnce();
    await expect(h.registration.cookies.subscribe([{ name: "x" }])).rejects.toThrow(TypeError);
    expect(h.native.subscribe).not.toHaveBeenCalled();
    expect(h.write).not.toHaveBeenCalled();
  } finally {
    await h.manager.quitAll();
  }
});

it("surfaces acquire quota errors as TypeError and storage errors before native subscribe", async () => {
  const h = setup();
  try {
    await expect(h.registration.cookies.subscribe([{ name: "x".repeat(4097) }])).rejects.toThrow(TypeError);
    h.write.mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(h.registration.cookies.subscribe([{ name: "ok" }])).rejects.toThrow("ENOSPC");
    expect(h.native.subscribe).not.toHaveBeenCalled();
    await h.registration.cookies.subscribe([{ name: "ok" }]);
    expect(h.native.subscribe).toHaveBeenCalledOnce();
  } finally {
    await h.manager.quitAll();
  }
});
