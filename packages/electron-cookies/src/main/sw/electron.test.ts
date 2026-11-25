import { EventEmitter } from "node:events";

import type { Cookie } from "electron";
import { afterEach, expect, it, vi } from "vitest";

import { createCookieJar, installCookieWorkerIpc, type CookieWorkerIpcOptions, type WakeRecord } from "../../main.ts";
import { cookieIpcChannels, type WorkerCookieEvent } from "../../shared.ts";
import { fakeCookieStore } from "../../testing/fake-store.ts";

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
function setup(taskTimeoutMs?: number) {
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
    taskTimeoutMs,
    jar,
    storage,
    log,
    isAppUrl: (value: string) => value.startsWith(origin + "/"),
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
  };
}

afterEach(() => vi.useRealTimers());

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

it("uses the configured event timeout and ignores a later ACK for the expired task", async () => {
  vi.useFakeTimers();
  const h = setup(250);
  try {
    h.change("inserted");
    await vi.advanceTimersByTimeAsync(0);
    const { eventId } = h.worker.send.mock.calls[0][1];
    h.worker.ipc.emit(channels.started, {}, eventId);
    await vi.advanceTimersByTimeAsync(249);
    expect(h.end).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.worker.send).toHaveBeenLastCalledWith(channels.finish, eventId);
    h.worker.ipc.emit(channels.ack, {}, eventId);
    expect(h.end).toHaveBeenCalledOnce();
  } finally {
    await h.adapter.quitAll();
  }
});
