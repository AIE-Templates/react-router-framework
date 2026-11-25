import { EventEmitter } from "node:events";
import { createContext, runInContext } from "node:vm";

import type { ExecutionScript } from "electron";
import { describe, expect, it, vi } from "vitest";

import { deferred } from "../main/sw/deferred.ts";
import { cookieIpcChannels, type Subscription, type WorkerCookieEvent } from "../shared.ts";
import { installServiceWorkerCookiePreload, type ServiceWorkerCookiePreloadOptions } from "./install-worker.ts";

const origin = "https://app.example";
const scope = origin + "/area/";
const scriptUrl = origin + "/scripts/sw.js";
const channels = cookieIpcChannels("fixture");
const item = { name: "x", path: "/", sameSite: "strict", partitioned: false, secure: true, domain: null } as const;

function setup(target = scope) {
  const invoke = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ ok: true, value: [] });
  const subscribe = vi.fn<(subscriptions: Subscription[]) => Promise<void>>().mockResolvedValue(undefined);
  const unsubscribe = vi.fn<(subscriptions: Subscription[]) => Promise<void>>().mockResolvedValue(undefined);
  const unregister = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const getSubscriptions = vi.fn<() => Promise<Subscription[]>>().mockResolvedValue([{ name: "x", url: scope }]);
  class Manager {
    subscribe(input: Subscription[]) {
      return subscribe(input);
    }
    unsubscribe(input: Subscription[]) {
      return unsubscribe(input);
    }
    getSubscriptions() {
      return getSubscriptions();
    }
  }
  const manager = new Manager();
  class Registration {
    get scope() {
      return target;
    }
    get cookies() {
      return manager;
    }
    active: object | null = {};
    unregister() {
      return unregister();
    }
  }
  class ChangeEvent extends Event {
    readonly changed;
    readonly deleted;
    declare waitUntil: (p: Promise<unknown>) => void;
    constructor(type: string, init: CookieChangeEventInit) {
      super(type);
      this.changed = init.changed;
      this.deleted = init.deleted;
    }
  }
  const registration = new Registration();
  const self = Object.assign(new EventTarget(), {
    registration,
    location: { href: scriptUrl },
    serviceWorker: registration.active,
    ExtendableCookieChangeEvent: ChangeEvent,
  });
  const fetch = vi.fn<(req: Request) => Promise<Response>>().mockResolvedValue(new Response());
  const nativeRequest: typeof Request = Object.hasOwn(Request.prototype, "url")
    ? Request
    : Object.getPrototypeOf(Request);
  const realm = createContext({
    self,
    location: self.location,
    EventTarget,
    AbortSignal,
    TextEncoder,
    Headers,
    Request: nativeRequest,
    fetch,
    URL,
    DOMException,
    ServiceWorkerRegistration: Registration,
    CookieStoreManager: Manager,
  });
  const ipc = Object.assign(new EventEmitter(), { send: vi.fn<(...args: unknown[]) => void>(), invoke });
  const executeInMainWorld = vi.fn<(script: ExecutionScript) => unknown>(({ func, args }) => {
    const run: (...params: unknown[]) => unknown = runInContext(
      "(" + Function.prototype.toString.call(func) + ")",
      realm,
    );
    return run(...(args ?? []));
  });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Electron owns the renderer transport.
  const ipcRenderer = ipc as unknown as ServiceWorkerCookiePreloadOptions["ipcRenderer"];
  installServiceWorkerCookiePreload({
    appOrigin: origin,
    appHost: "app.example",
    prefix: "fixture",
    ipcRenderer,
    contextBridge: { executeInMainWorld },
  });
  const send = (eventId: string, overrides?: Partial<WorkerCookieEvent>) =>
    ipc.emit(channels.deliver, {}, { eventId, changed: [item], deleted: [], ...overrides });
  return {
    ipc,
    send,
    realm,
    self,
    ChangeEvent,
    fetch,
    executeInMainWorld,
    invoke,
    subscribe,
    unsubscribe,
    unregister,
    getSubscriptions,
    registration,
  };
}

describe("serialized service-worker preload", () => {
  it("reads scope in the main world and passes through a foreign worker", () => {
    const h = setup("https://foreign.example/area/");
    expect(h.executeInMainWorld).toHaveBeenCalledTimes(1);
    expect(h.realm.cookieStore).toBeUndefined();
    expect(h.realm.fetch).toBe(h.fetch);
    expect(h.ipc.eventNames()).toEqual([]);
  });

  it("installs structured cookie conversion at script URL and honors the forwarded fetch credentials", async () => {
    const h = setup();
    const store: CookieStore = h.realm.cookieStore;
    await store.getAll({ url: "./sw.js#x" });
    expect(h.invoke).toHaveBeenCalledWith(channels.getAll, undefined);
    await store.set({ name: "x", value: "v", path: "" });
    expect(h.invoke).toHaveBeenCalledWith(channels.storeSet, expect.objectContaining({ path: "/scripts" }));
    await expect(store.set("__Http-x", "v")).rejects.toThrow("__Http-");
    const fetch: typeof globalThis.fetch = h.realm.fetch;
    await fetch(origin + "/data", { credentials: "omit" });
    const omit = h.fetch.mock.calls[0][0];
    expect(omit.headers.get("x-desktop-omit-cookies")).toBe("1");
    await fetch(omit, { credentials: "include" });
    expect(h.fetch.mock.calls[1][0].headers.has("x-desktop-omit-cookies")).toBe(false);
  });

  it("wraps subscribe/unsubscribe/unregister around main grants and waits for completion", async () => {
    const h = setup();
    const grant = deferred<{ operationId: string }>();
    const completed = deferred<void>();
    const native = deferred<void>();
    h.invoke.mockImplementation((channel) => (channel === channels.acquire ? grant.promise : completed.promise));
    h.subscribe.mockImplementationOnce(() => native.promise);
    const entry = { name: "initial", url: "../area/page" };
    const promise = h.registration.cookies.subscribe([entry]);
    entry.name = "mutated";
    expect(h.invoke).toHaveBeenCalledWith(channels.acquire, scope, {
      kind: "subscribe",
      subscriptions: [{ name: "initial", url: scope + "page" }],
    });
    expect(h.subscribe).not.toHaveBeenCalled();
    grant.resolve({ operationId: "grant" });
    await vi.waitFor(() => expect(h.subscribe).toHaveBeenCalledWith([{ name: "initial", url: scope + "page" }]));
    expect(h.invoke).not.toHaveBeenCalledWith(channels.complete, "grant", true);
    native.resolve();
    await vi.waitFor(() => expect(h.invoke).toHaveBeenCalledWith(channels.complete, "grant", true));
    completed.resolve();
    await promise;
    const error = new TypeError("native rejected");
    h.unsubscribe.mockRejectedValueOnce(error);
    await expect(h.registration.cookies.unsubscribe([{}])).rejects.toBe(error);
    expect(h.invoke).toHaveBeenLastCalledWith(channels.complete, "grant", false);

    const cleanup = deferred<void>();
    h.invoke.mockImplementation((channel) => (channel === channels.acquire ? grant.promise : cleanup.promise));
    const finished = vi.fn<() => void>();
    const unregister = h.registration.unregister().then((value) => {
      finished();
      return value;
    });
    await vi.waitFor(() => expect(h.invoke).toHaveBeenLastCalledWith(channels.complete, "grant", true));
    expect(h.unregister).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    cleanup.resolve();
    await expect(unregister).resolves.toBe(true);
  });

  it("SW-10/13 rechecks active after getSubscriptions, filters by name/path, and NACKs stale versions", async () => {
    const h = setup();
    const listener = vi.fn<() => void>();
    h.self.addEventListener("cookiechange", listener);
    const subscriptions = deferred<Subscription[]>();
    h.getSubscriptions.mockReturnValueOnce(subscriptions.promise);
    h.send("A");
    h.registration.active = null;
    subscriptions.resolve([{}]);
    await vi.waitFor(() => expect(h.ipc.send).toHaveBeenCalledExactlyOnceWith(channels.nack, "A"));
    h.send("B");
    expect(h.ipc.send).toHaveBeenLastCalledWith(channels.nack, "B");
    h.registration.active = h.self.serviceWorker;
    h.send("C", {
      changed: [
        { ...item, name: "other" },
        { ...item, path: "/are" },
      ],
    });
    await vi.waitFor(() => expect(h.ipc.send).toHaveBeenLastCalledWith(channels.ack, "C"));
    expect(listener).not.toHaveBeenCalled();
    h.send("D");
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce());
  });

  it("SW-11/12 ACKs only after the last appended promise settles, including rejection", async () => {
    const h = setup();
    const first = deferred<void>();
    const last = deferred<void>();
    const dispatched = deferred<InstanceType<typeof h.ChangeEvent>>();
    h.self.addEventListener("cookiechange", (event) => {
      if (!(event instanceof h.ChangeEvent)) throw new Error("wrong event interface");
      event.waitUntil(first.promise);
      dispatched.resolve(event);
    });
    h.send("A");
    const event = await dispatched.promise;
    event.waitUntil(last.promise);
    first.resolve();
    await first.promise;
    expect(h.ipc.send.mock.calls).toEqual([[channels.started, "A"]]);
    last.reject(new Error("listener failed"));
    await vi.waitFor(() =>
      expect(h.ipc.send.mock.calls).toEqual([
        [channels.started, "A"],
        [channels.ack, "A"],
      ]),
    );
    expect(() => event.waitUntil(Promise.resolve())).toThrow(expect.objectContaining({ name: "InvalidStateError" }));
  });

  it("SW-11/12b/13 tracks independent dynamic waitUntil counts and invalidates expired events", async () => {
    const h = setup();
    const pending = deferred<void>();
    const appended = deferred<void>();
    const events: InstanceType<typeof h.ChangeEvent>[] = [];
    h.self.addEventListener("cookiechange", (event) => {
      if (!(event instanceof h.ChangeEvent)) throw new Error("wrong event interface");
      events.push(event);
      if (events.length === 1) event.waitUntil(pending.promise);
    });
    h.send("A", { changed: [item, { ...item, name: "ignored" }], deleted: [item] });
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0]).toMatchObject({ changed: [item], deleted: [item], isTrusted: false });
    events[0].waitUntil(appended.promise);
    h.send("B");
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(h.ipc.send.mock.calls).toEqual([
      [channels.started, "A"],
      [channels.started, "B"],
      [channels.ack, "B"],
    ]);
    expect(() => events[1].waitUntil(Promise.resolve())).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    pending.reject(new Error("listener failed"));
    await Promise.resolve();
    expect(h.ipc.send).not.toHaveBeenCalledWith(channels.ack, "A");
    h.ipc.emit(channels.finish, {}, "A");
    expect(() => events[0].waitUntil(Promise.resolve())).toThrow(
      expect.objectContaining({ name: "InvalidStateError" }),
    );
    appended.resolve();
    await Promise.resolve();
    expect(h.ipc.send).not.toHaveBeenCalledWith(channels.ack, "A");
  });
});
