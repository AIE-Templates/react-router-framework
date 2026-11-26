import { EventEmitter } from "node:events";

import type { Cookie } from "electron";
import { afterEach, expect, it, vi } from "vitest";

import { createCookieJar, installCookieWorkerIpc, type CookieWorkerIpcOptions, type WakeRecord } from "../../main.ts";
import { cookieIpcChannels, type WorkerCookieEvent } from "../../shared.ts";
import { fakeCookieStore } from "../../testing/fake-store.ts";
import { deferred } from "./deferred.ts";

const origin = "test-app://site";
const scope = origin + "/area/";
const scriptURL = origin + "/scripts/sw.js";
const channels = cookieIpcChannels("fixture");

function ipcPort() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return Object.assign(new EventEmitter(), {
    handle(channel: string, fn: (...args: unknown[]) => unknown) {
      if (handlers.has(channel)) throw new Error("handler already installed");
      handlers.set(channel, fn);
    },
    invoke(channel: string, ...args: unknown[]) {
      return Promise.resolve().then(() => {
        const fn = handlers.get(channel);
        if (!fn) throw new Error("No handler");
        return fn(...args);
      });
    },
  });
}
function setup(timeouts: Pick<CookieWorkerIpcOptions, "wakeTimeoutMs" | "taskTimeoutMs" | "quitTimeoutMs"> = {}) {
  const ipc = ipcPort();
  const end = vi.fn<() => void>();
  const worker = {
    versionId: 17,
    scope,
    scriptURL,
    ipc: ipcPort(),
    isDestroyed: () => false,
    send: vi.fn<(channel: string, event: WorkerCookieEvent) => void>(),
    startTask: vi.fn<() => { end: typeof end }>(() => ({ end })),
  };
  const foreign = { ...worker, versionId: 33, scope: "https://foreign.example/", ipc: ipcPort() };
  const workers = Object.assign(new EventEmitter(), {
    startWorkerForScope: vi.fn<() => Promise<typeof worker>>().mockResolvedValue(worker),
    getAllRunning: () => ({ [foreign.versionId]: {}, [worker.versionId]: {} }),
    getWorkerFromVersionID: (id: number) => (id === worker.versionId ? worker : foreign),
  });
  const sender = {};
  const frame = { frameToken: "frame-token", origin, isDestroyed: vi.fn<() => boolean>().mockReturnValue(false) };
  const frameEvent = { senderFrame: frame, sender };
  const changes = new EventEmitter();
  const log = { warn: vi.fn<() => void>(), debug: vi.fn<() => void>() };
  const store = fakeCookieStore();
  const jar = createCookieJar({
    scheme: "test-app",
    host: "site",
    origin,
    storageOrigin: "https://jar.example",
    upstreamHost: "localhost",
    store,
    log,
    fromPartition: () => ({ cookies: fakeCookieStore() }),
    installPermissionPolicy: () => {},
  });
  let disk: readonly WakeRecord[] = [{ scope, name: "x", since: 1, eligible: true }];
  const storage = {
    read: () => disk,
    write: vi.fn<(rows: readonly WakeRecord[]) => Promise<void>>((rows) => {
      disk = rows;
      return Promise.resolve();
    }),
  };
  const options = {
    ipcMain: ipc,
    changes,
    serviceWorkers: workers,
    ...timeouts,
    jar,
    storage,
    log,
    isAppUrl: vi.fn<(value: string) => boolean>((value) => value.startsWith(origin + "/")),
    ownsSender: (contents: unknown) => contents === sender,
    prefix: "fixture",
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Only the IPC endpoints are replaced; exercise the real jar and manager.
  const adapter = installCookieWorkerIpc(options as unknown as CookieWorkerIpcOptions);
  const change = (cause: string, cookie: Partial<Cookie> = {}) =>
    changes.emit(
      "changed",
      {},
      { name: "x", value: "data", domain: ".jar.example", path: "/", expirationDate: 100, ...cookie },
      cause,
    );
  const status = (runningStatus: string) =>
    workers.emit("running-status-changed", { versionId: worker.versionId, runningStatus });
  return {
    adapter,
    change,
    jar,
    worker,
    status,
    foreign,
    workers,
    store,
    storage,
    log,
    disk: () => disk,
    end,
    ipc,
    frameEvent,
    isAppUrl: options.isAppUrl,
  };
}

afterEach(() => vi.useRealTimers());

it.each([undefined, 50])(
  "bounds quit with a stalled write and starts no later writes (quitTimeoutMs=%s)",
  async (quitTimeoutMs) => {
    vi.useFakeTimers();
    const h = setup({ quitTimeoutMs });
    const release = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (records) => {
      await release.promise;
      await persist(records);
    });
    const subscribe = { kind: "subscribe", subscriptions: [{ name: "new" }] };
    try {
      const active = h.worker.ipc.invoke(channels.acquire, {}, scope, subscribe);
      const queued = h.ipc.invoke(channels.acquire, h.frameEvent, "doc", origin + "/other/", subscribe);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.storage.write).toHaveBeenCalledOnce();
      const [snapshot] = h.storage.write.mock.calls[0];
      const finished = vi.fn<() => void>();
      const quit = h.adapter.quitAll().then(finished);
      await expect(active).rejects.toThrow("owner destroyed");
      await expect(queued).rejects.toThrow("owner destroyed");
      const deadline = quitTimeoutMs ?? 2_000;
      await vi.advanceTimersByTimeAsync(deadline - 1);
      expect(finished).not.toHaveBeenCalled();
      expect(h.log.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toHaveBeenCalledOnce();
      await quit;
      await h.adapter.quitAll();
      expect(h.log.warn).toHaveBeenCalledExactlyOnceWith(
        { timeoutMs: deadline },
        expect.stringMatching(/wake index.*timed out/i),
      );
      expect(h.disk().map((r) => r.name)).toEqual(["x"]);
      await expect(h.worker.ipc.invoke(channels.acquire, {}, scope, subscribe)).rejects.toThrow("closed");
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.disk()).toEqual(snapshot);
      expect(h.storage.write).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      release.resolve();
      await h.adapter.quitAll();
    }
  },
);

it("persists subscription cleanup when the stalled write finishes before the quit deadline", async () => {
  vi.useFakeTimers();
  const h = setup();
  const release = deferred<void>();
  const persist = h.storage.write.getMockImplementation()!;
  h.storage.write.mockImplementationOnce(async (records) => {
    await release.promise;
    await persist(records);
  });
  try {
    const grant = h.worker.ipc.invoke(channels.acquire, {}, scope, {
      kind: "subscribe",
      subscriptions: [{ name: "new" }],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.storage.write).toHaveBeenCalledOnce();
    const quit = h.adapter.quitAll();
    await expect(grant).rejects.toThrow("owner destroyed");
    release.resolve();
    await quit;
    expect(h.disk()).toEqual([
      expect.objectContaining({ name: "x", eligible: true }),
      expect.objectContaining({ name: "new", eligible: false }),
    ]);
    expect(h.log.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve();
    await h.adapter.quitAll();
  }
});

it("uses the Electron script URL on scoped IPC, shares jar writes and rejects foreign/stopped workers", async () => {
  const h = setup();
  try {
    const input = {
      name: "x",
      value: "worker",
      domain: null,
      path: "/scripts",
      expires: null,
      secure: true,
      sameSite: "strict",
      partitioned: false,
    };
    expect(await h.worker.ipc.invoke(channels.storeSet, {}, input)).toEqual({ ok: true, value: undefined });
    expect(await h.worker.ipc.invoke(channels.getAll, {}, "x")).toMatchObject({ ok: true, value: [input] });
    expect(h.store.get).toHaveBeenCalledWith({ httpOnly: false, url: "https://jar.example/scripts/sw.js" });
    expect(await h.jar.cookieHeader({ path: "/scripts/page", headers: new Headers() })).toBe("x=worker");
    await expect(h.foreign.ipc.invoke(channels.getAll, {})).rejects.toThrow("No handler");
    await expect(
      h.worker.ipc.invoke(channels.acquire, {}, origin + "/another/", { kind: "unregister" }),
    ).rejects.toThrow("Invalid worker scope");
    h.status("stopped");
    expect(await h.worker.ipc.invoke(channels.getAll, {})).toMatchObject({
      ok: false,
      error: { name: "SecurityError" },
    });
    h.status("starting");
    h.status("running");
    expect(await h.worker.ipc.invoke(channels.getAll, {})).toMatchObject({ ok: true, value: [input] });
  } finally {
    await h.adapter.quitAll();
  }
});

it("derives empty structured paths from the worker script URL for set and delete", async () => {
  const h = setup();
  try {
    const input = {
      name: "x",
      value: "worker",
      path: "",
      domain: null,
      secure: true,
      sameSite: "strict",
      partitioned: false,
    };
    for (const expires of [null, 0]) {
      expect(await h.worker.ipc.invoke(channels.storeSet, {}, { ...input, expires })).toEqual({
        ok: true,
        value: undefined,
      });
      expect(h.store.set).toHaveBeenLastCalledWith(
        expect.objectContaining({ url: "https://jar.example/scripts/sw.js", path: "" }),
      );
      expect(await h.jar.cookieHeader({ path: "/scripts/page", headers: new Headers() })).toBe(
        expires === null ? "x=worker" : undefined,
      );
      expect(await h.jar.cookieHeader({ path: "/area/page", headers: new Headers() })).toBeUndefined();
    }
  } finally {
    await h.adapter.quitAll();
  }
});

it("matches the serialized script URL prefix across registration paths before reading the jar", async () => {
  const h = setup();
  try {
    const read = (url: unknown) => h.worker.ipc.invoke(channels.getAll, {}, "x", url);
    for (const url of [scope + "page", scriptURL + "/../other", "https://other.example/", "/area/", {}]) {
      expect(await read(url)).toEqual({
        ok: false,
        error: { name: "TypeError", message: "URL must be within Service Worker scope" },
      });
    }
    expect(h.store.get).not.toHaveBeenCalled();
    expect(await read(scriptURL + "/deeper#fragment")).toEqual({ ok: true, value: [] });
    expect(h.store.get).toHaveBeenCalledWith({ url: "https://jar.example/scripts/sw.js/deeper", httpOnly: false });
    expect(await read(scriptURL + "-suffix")).toEqual({ ok: true, value: [] });
    expect(h.store.get).toHaveBeenCalledWith({ url: "https://jar.example/scripts/sw.js-suffix", httpOnly: false });
  } finally {
    await h.adapter.quitAll();
  }
});

it("maps cookie causes and drives separate keep-alives by started, ack, stop and quit", async () => {
  const h = setup();
  try {
    for (const cause of ["overwrite", "inserted-no-change-overwrite"]) h.change(cause);
    h.change("inserted", { httpOnly: true });
    h.change("inserted", { domain: "external.example" });
    expect(h.workers.startWorkerForScope).not.toHaveBeenCalled();
    h.change("inserted-no-value-change-overwrite");
    h.change("expired");
    await vi.waitFor(() => expect(h.worker.send).toHaveBeenCalledTimes(1));
    const [channel, first] = h.worker.send.mock.calls[0];
    expect(channel).toBe(channels.deliver);
    expect(first.changed[0]).toMatchObject({ name: "x", domain: "site", expires: 100_000, value: "data" });
    h.worker.ipc.emit(channels.started, {}, first.eventId);
    await vi.waitFor(() => expect(h.worker.send).toHaveBeenCalledTimes(2));
    const second = h.worker.send.mock.calls[1][1];
    expect(second.deleted).toHaveLength(1);
    expect(second.deleted[0]).not.toHaveProperty("value");
    expect(second.deleted[0]).not.toHaveProperty("expires");
    h.worker.ipc.emit(channels.ack, {}, second.eventId);
    expect(h.end).toHaveBeenCalledTimes(1);
    h.status("stopped");
    expect(h.end).toHaveBeenCalledTimes(2);
    h.status("starting");
    h.change("inserted");
    await vi.waitFor(() => expect(h.worker.send).toHaveBeenCalledTimes(3));
  } finally {
    await h.adapter.quitAll();
  }
  expect(h.end).toHaveBeenCalledTimes(3);
});

it("validates frame ownership and releases a shared scope on frame and worker destruction", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    const unregister = { kind: "unregister" };
    await expect(
      h.ipc.invoke(channels.acquire, { ...h.frameEvent, sender: {} }, "doc", scope, unregister),
    ).rejects.toThrow("Invalid subscription sender");
    await expect(
      h.ipc.invoke(channels.acquire, h.frameEvent, "doc", scope, {
        kind: "subscribe",
        subscriptions: [{ url: "https://elsewhere/" }],
      }),
    ).rejects.toThrow("Invalid subscription");
    const grant = await h.ipc.invoke(channels.acquire, h.frameEvent, "doc", scope, unregister);
    expect.assert(grant && typeof grant === "object" && "operationId" in grant);
    await h.worker.ipc.invoke(channels.complete, {}, grant.operationId, true);
    expect(h.storage.write).not.toHaveBeenCalled();
    const workerGrant = h.worker.ipc.invoke(channels.acquire, {}, scope, {
      kind: "subscribe",
      subscriptions: [{ name: "x" }],
    });
    h.frameEvent.senderFrame.isDestroyed.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(100);
    await workerGrant;
    expect(h.disk()[0]).toMatchObject({ name: "x", eligible: true });
    h.frameEvent.senderFrame.isDestroyed.mockReturnValue(false);
    const after = h.ipc.invoke(channels.acquire, h.frameEvent, "new", scope, unregister);
    h.status("stopped");
    const next = await after;
    expect.assert(next && typeof next === "object" && "operationId" in next);
    await h.ipc.invoke(channels.complete, h.frameEvent, "new", next.operationId, true);
    expect(h.disk()).toEqual([]);
  } finally {
    await h.adapter.quitAll();
  }
});

it("retains a registration hint after Electron's ambiguous wake error and recovers on a later change", async () => {
  vi.useFakeTimers();
  const h = setup();
  try {
    h.workers.startWorkerForScope.mockRejectedValue(new Error("Failed to start service worker."));
    h.change("inserted");
    await vi.advanceTimersByTimeAsync(2100);
    expect(h.workers.startWorkerForScope).toHaveBeenCalledTimes(4);
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.storage.write).not.toHaveBeenCalled();
    h.workers.startWorkerForScope.mockResolvedValue(h.worker);
    h.change("inserted");
    await vi.advanceTimersByTimeAsync(0);
    expect(h.worker.send).toHaveBeenCalledOnce();
  } finally {
    await h.adapter.quitAll();
  }
});

it("orders subscribe and the next change even when the performance clock stays on the same tick", async () => {
  vi.useFakeTimers();
  const h = setup();
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const grant = await h.worker.ipc.invoke(channels.acquire, {}, scope, {
      kind: "subscribe",
      subscriptions: [{ name: "new" }],
    });
    expect.assert(grant && typeof grant === "object" && "operationId" in grant);
    await h.worker.ipc.invoke(channels.complete, {}, grant.operationId, true);
    h.change("inserted", { name: "new" });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.worker.send).toHaveBeenCalledOnce();
    expect(h.worker.send.mock.calls[0][1].changed).toMatchObject([{ name: "new" }]);
  } finally {
    clock.mockRestore();
    await h.adapter.quitAll();
  }
});

it("retries stalled wakes at the configured timeout and delivers the next change after exhaustion", async () => {
  vi.useFakeTimers();
  const wakeTimeoutMs = 250;
  const h = setup({ wakeTimeoutMs });
  try {
    h.workers.startWorkerForScope.mockImplementation(() => deferred<typeof h.worker>().promise);
    h.change("inserted", { value: "first" });
    h.change("inserted", { value: "queued" });
    for (const [i, delay] of [100, 400, 1_600].entries()) {
      await vi.advanceTimersByTimeAsync(wakeTimeoutMs + delay - 1);
      expect(h.workers.startWorkerForScope).toHaveBeenCalledTimes(i + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.workers.startWorkerForScope).toHaveBeenCalledTimes(i + 2);
    }
    await vi.advanceTimersByTimeAsync(wakeTimeoutMs);
    expect(h.log.warn).toHaveBeenCalledOnce();
    expect(h.worker.startTask).not.toHaveBeenCalled();
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    h.workers.startWorkerForScope.mockResolvedValue(h.worker);
    h.change("inserted", { value: "after recovery" });
    await vi.advanceTimersByTimeAsync(0);
    const { eventId } = h.worker.send.mock.calls[0][1];
    h.worker.ipc.emit(channels.ack, {}, eventId);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.worker.send.mock.calls.map(([, event]) => event.changed[0].value)).toEqual(["after recovery"]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await h.adapter.quitAll();
  }
});

it.each([true, false])("uses the event timeout and ignores a later ACK (started=%s)", async (started) => {
  vi.useFakeTimers();
  const h = setup({ taskTimeoutMs: 250 });
  try {
    h.change("inserted");
    await vi.advanceTimersByTimeAsync(0);
    const { eventId } = h.worker.send.mock.calls[0][1];
    if (started) h.worker.ipc.emit(channels.started, {}, eventId);
    await vi.advanceTimersByTimeAsync(249);
    expect(h.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.worker.send).toHaveBeenLastCalledWith(channels.finish, eventId);
    const dropWarning = [{ scope, eventId }, expect.stringContaining("Dropping")];
    expect(h.log.warn.mock.calls).toEqual(started ? [] : [dropWarning]);
    h.worker.ipc.emit(channels.ack, {}, eventId);
    expect(h.end).toHaveBeenCalledOnce();
  } finally {
    await h.adapter.quitAll();
  }
});

it("rejects a foreign frame origin in an owned webContents", async () => {
  const h = setup();
  try {
    const foreign = { ...h.frameEvent, senderFrame: { ...h.frameEvent.senderFrame, origin: "null" } };
    await expect(h.ipc.invoke(channels.acquire, foreign, "doc", scope, { kind: "unregister" })).rejects.toThrow(
      "Invalid subscription sender",
    );
    const grant = await h.ipc.invoke(channels.acquire, h.frameEvent, "doc", scope, { kind: "unregister" });
    expect(grant).toHaveProperty("operationId");
  } finally {
    await h.adapter.quitAll();
  }
});

it("rejects a foreign registration scope from an authorized frame", async () => {
  const h = setup();
  try {
    const acquire = (target: string) =>
      h.ipc.invoke(channels.acquire, h.frameEvent, "doc", target, { kind: "unregister" });
    await expect(acquire(h.foreign.scope)).rejects.toThrow("Invalid registration scope");
    expect(await acquire(scope)).toHaveProperty("operationId");
  } finally {
    await h.adapter.quitAll();
  }
});

it("rechecks the started worker scope against host policy after the native await", async () => {
  vi.useFakeTimers();
  const h = setup();
  const waking = deferred<typeof h.worker>();
  h.workers.startWorkerForScope.mockReturnValueOnce(waking.promise);
  try {
    h.change("inserted");
    expect(h.workers.startWorkerForScope).toHaveBeenCalledOnce();
    h.isAppUrl.mockReturnValue(false);
    waking.resolve(h.worker);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.worker.startTask).not.toHaveBeenCalled();
    h.isAppUrl.mockReset();
    await vi.advanceTimersByTimeAsync(100);
    expect(h.worker.send).toHaveBeenCalledOnce();
  } finally {
    waking.resolve(h.worker);
    await h.adapter.quitAll();
  }
});

it.each(["subscribe", "unsubscribe"] as const)(
  "bounds a stalled %s write and admits a retry after reconciliation",
  async (kind) => {
    vi.useFakeTimers();
    const h = setup();
    const release = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (records) => {
      await release.promise;
      await persist(records);
    });
    const acquire = (target: string, operation: string) =>
      h.ipc.invoke(channels.acquire, h.frameEvent, "doc", target, {
        kind: operation,
        subscriptions: [{ name: operation === "subscribe" ? "new" : "x" }],
      });
    try {
      const complete = (grant: unknown) => {
        expect.assert(grant && typeof grant === "object" && "operationId" in grant);
        return h.ipc.invoke(channels.complete, h.frameEvent, "doc", grant.operationId, true);
      };
      const pending = kind === "subscribe" ? acquire(scope, kind) : complete(await acquire(scope, kind));
      const result = pending.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      const otherScope = origin + "/other/";
      const queued = acquire(otherScope, "subscribe").catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.storage.write).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      const timeout = new Error("Cookie wake index write timed out. Retry later.");
      expect(await result).toEqual(kind === "subscribe" ? timeout : undefined);
      expect(await queued).toEqual(timeout);
      await expect(acquire(otherScope, "subscribe")).rejects.toThrow("still pending");
      expect(h.storage.write).toHaveBeenCalledOnce();
      release.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.disk().map((r) => r.name)).toEqual(kind === "subscribe" ? ["x"] : []);
      await complete(await acquire(otherScope, "subscribe"));
      expect(h.disk().map((r) => r.scope)).toEqual(kind === "subscribe" ? [scope, otherScope] : [otherScope]);
      h.change("inserted", { name: "new" });
      expect(h.workers.startWorkerForScope.mock.calls).not.toContainEqual([scope]);
    } finally {
      release.resolve();
      await h.adapter.quitAll();
    }
  },
);
