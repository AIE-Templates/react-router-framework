import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installWorkerEvents, type WorkerEventBridge } from "../../preload/worker-events.ts";
import {
  CookieWorkerManager,
  type ChangeItems,
  type CookieItem,
  type Operation,
  type WakeRecord,
  type WorkerPort,
  type WakeLogger,
  type WakeStorage,
} from "./cookie-worker-manager.ts";
import { deferred } from "./deferred.ts";

const scope = "app://app/sub/";
const otherScope = "app://app/other/";
const subscribe: Operation = { kind: "subscribe", subscriptions: [{ name: "x" }] };
const unsubscribe: Operation = { kind: "unsubscribe", subscriptions: [{ name: "x" }] };
const unregister: Operation = { kind: "unregister" };
const x = { name: "x", path: "/", value: "x" };
const y = { name: "y", path: "/", value: "y" };
type Item = CookieItem & { value?: string };
type Message = ChangeItems<Item> & { eventId: string };

const cookie = (name: string, path: string) => ({ name, path });

function seed(name = "x", target = scope): WakeRecord {
  return { scope: target, name, since: 0, eligible: true };
}

function workerPort(versionId: number, target = scope) {
  const ends: ReturnType<typeof vi.fn<() => void>>[] = [];
  return {
    versionId,
    scope: target,
    ends,
    startTask: vi.fn<WorkerPort<Item>["startTask"]>(() => {
      const end = vi.fn<() => void>();
      ends.push(end);
      return { end };
    }),
    send: vi.fn<(event: Message) => void>(),
    finish: vi.fn<(eventId: string) => void>(),
  };
}

function setup(initial: WakeRecord[] = []) {
  let disk: readonly WakeRecord[] = initial;
  const worker = workerPort(7);
  const startWorkerForScope = vi.fn<(scope: string) => Promise<WorkerPort<Item> | null>>().mockResolvedValue(worker);
  const storage = {
    read: vi.fn<WakeStorage["read"]>(() => disk),
    write: vi.fn<WakeStorage["write"]>((records) => {
      disk = structuredClone(records);
      return Promise.resolve();
    }),
  };
  const logger = { warn: vi.fn<WakeLogger["warn"]>() };
  const options = {
    storage,
    logger,
    native: { startWorkerForScope },
    scheduler: {
      now: () => Date.now(),
      after: (ms: number, callback: () => void) => {
        const timer = setTimeout(callback, ms);
        return () => clearTimeout(timer);
      },
    },
  };
  const manager = new CookieWorkerManager(options);
  return {
    manager,
    options,
    storage,
    logger,
    worker,
    startWorkerForScope,
    disk: () => disk,
    change: (value = "value") => manager.onChange({ changed: [{ ...x, value }], deleted: [], time: Date.now() }),
    ref: (i = 0) => ({ versionId: worker.versionId, eventId: worker.send.mock.calls[i][0].eventId }),
  };
}

const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("wake index and subscription ownership", () => {
  it("SW-07/08: loads hints synchronously, matches cookie path boundaries and filters individual items", async () => {
    const h = setup([{ scope, url: scope + "deep", since: 1, eligible: true }]);
    expect(h.storage.read).toHaveBeenCalledTimes(1);
    h.manager.onChange({
      changed: [cookie("a", "/sub/deeper"), cookie("x", "/sub/deep/private")],
      deleted: [],
      time: Date.now(),
    });
    expect(h.startWorkerForScope).not.toHaveBeenCalled();
    h.manager.onChange({
      changed: [x, cookie("a", "/sub"), cookie("b", "/sub/"), cookie("c", "/su")],
      deleted: [cookie("d", "/sub/deep"), cookie("e", "/s")],
      time: Date.now(),
    });
    await tick();
    expect(h.worker.send).toHaveBeenCalledExactlyOnceWith({
      eventId: expect.any(String),
      changed: [x, cookie("a", "/sub"), cookie("b", "/sub/")],
      deleted: [cookie("d", "/sub/deep")],
    });
    await h.manager.quitAll();
  });

  it("SW-07/09: omitted URL uses scope, empty name is exact, and only strictly older subscriptions qualify", async () => {
    const h = setup([{ ...seed("any"), eligible: false }]);
    const grant = await h.manager.acquire(scope, { kind: "subscribe", subscriptions: [{ name: "" }] }, 7);
    await h.manager.complete(grant.operationId, true);
    h.change();
    h.manager.onChange({ changed: [{ name: "", path: "/sub/private" }], deleted: [], time: Date.now() });
    expect(h.startWorkerForScope).not.toHaveBeenCalled();
    const empty = { name: "", path: "/sub" };
    const hintOnly = { name: "any", path: "/" };
    h.manager.onChange({ changed: [empty, hintOnly], deleted: [], time: Date.now() });
    await tick(1);
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(1);
    expect(h.worker.send).not.toHaveBeenCalled();
    h.manager.onChange({ changed: [empty, hintOnly], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send.mock.calls[0][0].changed).toEqual([empty]);
    await h.manager.quitAll();
  });

  it("SW-08/12d: durable subscribe precedes grant and holds the scope through the native call", async () => {
    const h = setup();
    const writing = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (snapshot) => {
      await writing.promise;
      await persist(snapshot);
    });
    const subscribed = vi.fn<() => void>();
    const removed = vi.fn<() => void>();
    const a = h.manager.acquire(scope, subscribe, "frame").then((grant) => {
      subscribed();
      return grant;
    });
    const b = h.manager.acquire(scope, unsubscribe, 7).then((grant) => {
      removed();
      return grant;
    });
    await tick();
    expect(h.storage.write).toHaveBeenCalledTimes(1);
    expect(subscribed).not.toHaveBeenCalled();
    writing.resolve();
    const first = await a;
    expect(h.disk()).toEqual([{ ...seed(), since: Date.now() }]);
    expect(removed).not.toHaveBeenCalled();
    await h.manager.complete(first.operationId, true);
    const second = await b;
    await tick(1);
    const writingAgain = deferred<void>();
    h.storage.write.mockImplementationOnce(persist).mockImplementationOnce(async (snapshot) => {
      await writingAgain.promise;
      await persist(snapshot);
    });
    const again = h.manager.acquire(scope, subscribe, "frame");
    await h.manager.complete(second.operationId, true);
    expect(h.disk()).toEqual([]);
    h.change();
    expect(h.startWorkerForScope).not.toHaveBeenCalled();
    writingAgain.resolve();
    await h.manager.complete((await again).operationId, true);
    await h.manager.complete(second.operationId, true);
    expect(h.disk()).toEqual([{ ...seed(), since: Date.now() }]);
  });

  it("SW-08: a failed write rejects the grant, and a duplicate retries persistence before grant", async () => {
    const h = setup();
    h.storage.write.mockRejectedValueOnce(new Error("disk unavailable"));
    await expect(h.manager.acquire(scope, subscribe, "frame")).rejects.toThrow("disk unavailable");
    expect(h.disk()).toEqual([]);
    h.change("after failed subscribe");
    expect(h.startWorkerForScope).not.toHaveBeenCalled();
    await tick(1);
    const next = await h.manager.acquire(scope, subscribe, "frame");
    await h.manager.complete(next.operationId, false);
    expect(h.disk()).toEqual([{ ...seed(), since: Date.now(), eligible: false }]);
    expect(h.storage.write).toHaveBeenCalledTimes(3);
  });

  it("SW-09: a failed wildcard wakes but cannot authorize an event older than the first successful subscribe", async () => {
    const h = setup();
    const old = await h.manager.acquire(scope, { kind: "subscribe", subscriptions: [{}] }, "frame");
    await h.manager.complete(old.operationId, false);
    const wake = deferred<WorkerPort<Item>>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    await tick(1);
    h.change("before subscribe");
    expect(h.startWorkerForScope).toHaveBeenCalledOnce();
    await tick(1);
    const next = await h.manager.acquire(scope, subscribe, 7);
    await h.manager.complete(next.operationId, true);
    wake.resolve(h.worker);
    await tick();
    expect(h.worker.send).not.toHaveBeenCalled();
    await tick(1);
    h.change("after subscribe");
    await tick();
    expect(h.worker.send.mock.calls.map(([event]) => event.changed[0].value)).toEqual(["after subscribe"]);
    await h.manager.quitAll();
  });

  it("SW-08: losing the owner during persistence leaves its ungranted hint wake-only after restart", async () => {
    const h = setup();
    const writing = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (records) => {
      await writing.promise;
      await persist(records);
    });
    const acquiring = h.manager.acquire(scope, subscribe, "frame");
    await tick();
    expect(h.storage.write).toHaveBeenCalledOnce();
    h.manager.ownerDestroyed("frame");
    await expect(acquiring).rejects.toThrow("owner destroyed");
    writing.resolve();
    await h.manager.quitAll();
    expect(h.disk()).toEqual([{ ...seed(), eligible: false, since: 1_000 }]);
    const restarted = new CookieWorkerManager(h.options);
    restarted.onChange({ changed: [x], deleted: [], time: Date.now() });
    await tick();
    expect(h.startWorkerForScope).toHaveBeenCalledOnce();
    expect(h.worker.send).not.toHaveBeenCalled();
    await restarted.quitAll();
  });

  it("SW-09: a failed subscribe preserves existing eligibility and withholds new hints until completion", async () => {
    const h = setup([seed()]);
    const grant = await h.manager.acquire(scope, { kind: "subscribe", subscriptions: [{ name: "x" }, {}] }, 7);
    await tick(1);
    h.manager.onChange({ changed: [x, y], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send.mock.calls[0][0].changed).toEqual([x]);
    h.manager.ack(h.ref());
    await h.manager.complete(grant.operationId, false);
    h.manager.onChange({ changed: [x, y], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send.mock.calls[1][0].changed).toEqual([x]);
    await h.manager.quitAll();
  });

  it("SW-08: the first change after a backward clock jump on restart reaches the old subscription", async () => {
    const h = setup();
    const grant = await h.manager.acquire(scope, subscribe, "frame");
    await h.manager.complete(grant.operationId, true);
    await h.manager.quitAll();
    vi.setSystemTime(500);
    const restarted = new CookieWorkerManager(h.options);
    restarted.onChange({ changed: [x], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send).toHaveBeenCalledExactlyOnceWith({ changed: [x], deleted: [], eventId: expect.any(String) });
    await restarted.quitAll();
  });

  it("SW-08: different scope owners can run concurrently and their disk snapshots land in order", async () => {
    const h = setup();
    const write = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (snapshot) => {
      await write.promise;
      await persist(snapshot);
    });
    const a = h.manager.acquire(scope, subscribe, "frame");
    const b = h.manager.acquire(otherScope, subscribe, "frame");
    await tick();
    expect(h.storage.write).toHaveBeenCalledTimes(1);
    write.resolve();
    const [first, second] = await Promise.all([a, b]);
    expect(h.disk().map((record) => record.scope)).toEqual([scope, otherScope]);
    await Promise.all([h.manager.complete(first.operationId, true), h.manager.complete(second.operationId, true)]);
  });

  it("SW-09: duplicate subscribe with explicit default URL keeps since across an in-flight wake", async () => {
    const h = setup([seed()]);
    const wake = deferred<WorkerPort<Item>>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    h.change();
    await tick(20);
    const grant = await h.manager.acquire(
      scope,
      { kind: "subscribe", subscriptions: [{ name: "x", url: scope }] },
      "frame",
    );
    await h.manager.complete(grant.operationId, true);
    expect(h.disk()).toEqual([seed()]);
    wake.resolve(h.worker);
    await tick();
    expect(h.worker.send).toHaveBeenCalledTimes(1);
    await h.manager.quitAll();
  });

  it("SW-12e: expired subscribe can resume after unsubscribe; restart retains the record and unpins it", async () => {
    const h = setup();
    const first = await h.manager.acquire(scope, subscribe, "slow frame");
    const native = new Set<string>();
    const resumeNative = deferred<void>();
    const subscribing = resumeNative.promise.then(() => {
      native.add("x");
      return h.manager.complete(first.operationId, true);
    });
    const queued = h.manager.acquire(scope, unsubscribe, 7);
    await tick(9_999);
    expect(h.manager.hasOwner("slow frame")).toBe(true);
    expect(h.disk()[0].pinned).toBeUndefined();
    expect(h.logger.warn).not.toHaveBeenCalled();
    await tick(1);
    const next = await queued;
    expect(h.disk()[0].pinned).toBe(true);
    native.delete("x");
    await h.manager.complete(next.operationId, true);
    expect([...native]).toEqual([]);
    resumeNative.resolve();
    await subscribing;
    expect([...native]).toEqual(["x"]);
    expect(h.disk()).toEqual([{ ...seed(), since: 1_000, pinned: true }]);
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith(
      { scope, operationId: first.operationId },
      expect.stringContaining("lease"),
    );
    await h.manager.quitAll();

    const restarted = new CookieWorkerManager(h.options);
    restarted.onChange({ changed: [x], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send).toHaveBeenCalledTimes(1);
    const remove = await restarted.acquire(scope, unsubscribe, 7);
    await restarted.complete(remove.operationId, true);
    expect(h.disk()).toEqual([]);
    await restarted.quitAll();
  });

  it("SW-12e: expired unsubscribe and its late completion cannot delete or release a new owner's records", async () => {
    const h = setup([seed()]);
    const first = await h.manager.acquire(scope, unsubscribe, "frame");
    await tick(10_000);
    const second = await h.manager.acquire(scope, subscribe, 7);
    const granted = vi.fn<() => void>();
    const third = h.manager.acquire(scope, unregister, "frame").then((g) => {
      granted();
      return g;
    });
    await h.manager.complete(first.operationId, true);
    await tick();
    expect(granted).not.toHaveBeenCalled();
    expect(h.disk()).toEqual([seed()]);
    await h.manager.complete(second.operationId, true);
    await h.manager.complete((await third).operationId, false);
    expect(h.disk()).toEqual([seed()]);
  });

  it("SW-12e: destroying a frame or worker releases its grants and rejects its queued requests", async () => {
    const h = setup([seed()]);
    const held = await h.manager.acquire(scope, unsubscribe, 7);
    const dead = h.manager.acquire(scope, unsubscribe, 7);
    const next = h.manager.acquire(scope, subscribe, "frame");
    h.manager.workerDestroyed(7);
    await expect(dead).rejects.toThrow("owner destroyed");
    const newGrant = await next;
    await h.manager.complete(held.operationId, true);
    const waiting = h.manager.acquire(scope, unregister, "another frame");
    h.manager.ownerDestroyed("frame");
    await h.manager.complete(newGrant.operationId, true);
    await h.manager.complete((await waiting).operationId, false);
    expect(h.disk()).toEqual([seed()]);
    expect(h.logger.warn).not.toHaveBeenCalled();
  });
});

describe("registration changes during delivery", () => {
  it("SW-09/12e: unregister cancels queued events and retries before granting the replacement subscribe", async () => {
    const h = setup([seed()]);
    h.startWorkerForScope.mockRejectedValueOnce(new Error("busy"));
    h.change("retry");
    h.change("queued");
    await tick(1);
    const remove = await h.manager.acquire(scope, unregister, "A");
    const b = h.manager.acquire(scope, subscribe, "B");
    const writing = deferred<void>();
    const persist = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (snapshot) => {
      await writing.promise;
      await persist(snapshot);
    });
    const completed = h.manager.complete(remove.operationId, true);
    await tick(2_100);
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(1);
    expect(h.storage.write).toHaveBeenCalledTimes(1);
    expect(h.worker.send).not.toHaveBeenCalled();
    writing.resolve();
    await completed;
    await h.manager.complete((await b).operationId, true);
    expect(h.disk()).toEqual([{ ...seed(), since: Date.now() }]);
    await tick(1);
    h.change("B");
    await tick();
    expect(h.worker.send.mock.calls.map(([event]) => event.changed[0].value)).toEqual(["B"]);
    await h.manager.quitAll();
  });

  it("SW-12e: expired unregister cancels A, keeps wake hints, and rejects E even when its wake returns after B subscribes", async () => {
    const h = setup([seed()]);
    const oldWake = deferred<WorkerPort<Item>>();
    const wakeE = deferred<WorkerPort<Item>>();
    h.startWorkerForScope.mockReturnValueOnce(oldWake.promise).mockReturnValueOnce(wakeE.promise);
    const a = await h.manager.acquire(scope, unregister, "A");
    h.change("A");
    h.change("queued A");
    await tick(10_000);
    expect(h.disk()).toEqual([{ ...seed(), eligible: false }]);
    h.change("E");
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(2);
    await tick(1);
    const b = await h.manager.acquire(scope, subscribe, "B");
    await h.manager.complete(a.operationId, true);
    expect(h.disk()).toEqual([{ ...seed(), since: Date.now() }]);
    await h.manager.complete(b.operationId, true);
    await tick(1);
    h.change("B");
    oldWake.resolve(h.worker);
    wakeE.resolve(h.worker);
    await tick();
    expect(h.worker.send.mock.calls.map(([event]) => event.changed[0].value)).toEqual(["B"]);
    await h.manager.quitAll();
  });

  it("SW-12a/12e: no-registration cleanup waits for ownership, compares before its own bump and removes pinned records", async () => {
    const h = setup();
    await h.manager.acquire(scope, subscribe, "frame");
    await tick(10_000);
    const held = await h.manager.acquire(scope, unsubscribe, 7);
    h.startWorkerForScope.mockResolvedValueOnce(null);
    h.change();
    await tick();
    expect(h.disk()[0].pinned).toBe(true);
    await h.manager.complete(held.operationId, false);
    await tick();
    expect(h.disk()).toEqual([]);
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(1);
  });

  it("SW-12a/12e: no-registration cleanup compares at queue head, after an intervening grant with no index write", async () => {
    const h = setup([seed()]);
    const first = await h.manager.acquire(scope, unsubscribe, "holder");
    const wake = deferred<null>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    h.change();
    const intervening = h.manager.acquire(scope, unsubscribe, "other frame");
    wake.resolve(null);
    await tick();
    await h.manager.complete(first.operationId, false);
    const second = await intervening;
    h.manager.ownerDestroyed("other frame");
    await h.manager.complete(second.operationId, true);
    await tick();
    expect(h.disk()).toEqual([seed()]);
    expect(h.storage.write).not.toHaveBeenCalled();
  });

  it("SW-12a: definitive absence on retry uses the revision after an operation during backoff", async () => {
    const h = setup([seed()]);
    h.startWorkerForScope.mockRejectedValueOnce(new Error("busy")).mockResolvedValueOnce(null);
    h.change();
    await tick(99);
    const intervening = await h.manager.acquire(scope, unsubscribe, "frame");
    await h.manager.complete(intervening.operationId, false);
    expect(h.disk()).toEqual([seed()]);
    await tick(1);
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(2);
    expect(h.disk()).toEqual([]);
    h.change();
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(2);
  });

  it("SW-12a: deletion after wake starts advances the revision independently of its earlier grant", async () => {
    const h = setup([seed(), seed("y")]);
    const remove = await h.manager.acquire(scope, unsubscribe, "frame");
    const wake = deferred<null>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    h.change();
    await h.manager.complete(remove.operationId, true);
    wake.resolve(null);
    await tick();
    expect(h.disk()).toEqual([seed("y")]);
  });

  it("SW-12e: a destroyed unregister holder leaves durable wake-only hints and drops its in-flight wake", async () => {
    const h = setup([seed()]);
    const wake = deferred<WorkerPort<Item>>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    await h.manager.acquire(scope, unregister, 7);
    h.change();
    h.manager.workerDestroyed(7);
    wake.resolve(h.worker);
    await tick();
    expect(h.worker.send).not.toHaveBeenCalled();
    expect(h.disk()).toEqual([{ ...seed(), eligible: false }]);
    await h.manager.quitAll();
    const restarted = new CookieWorkerManager(h.options);
    restarted.onChange({ changed: [x], deleted: [], time: Date.now() });
    await tick();
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(2);
    expect(h.worker.send).not.toHaveBeenCalled();
    await restarted.quitAll();
  });

  it("SW-12a: missing-registration result from an older wake preserves a new subscription", async () => {
    const h = setup([seed()]);
    const wake = deferred<null>();
    h.startWorkerForScope.mockReturnValueOnce(wake.promise);
    h.change();
    const grant = await h.manager.acquire(scope, { kind: "subscribe", subscriptions: [{ name: "y" }] }, "B");
    await h.manager.complete(grant.operationId, true);
    wake.resolve(null);
    await tick();
    expect(h.disk()).toEqual([seed(), { ...seed("y"), since: Date.now() }]);
    await tick(1);
    h.manager.onChange({ changed: [y], deleted: [], time: Date.now() });
    await tick();
    expect(h.worker.send.mock.calls[0][0].changed).toEqual([y]);
    await h.manager.quitAll();
  });
});

describe("active worker delivery and event lifetime", () => {
  it("SW-12a: wakes immediately and retries at 100/400/1600 ms, warns once, then accepts the next event", async () => {
    const h = setup([seed()]);
    for (let i = 0; i < 4; i++) h.startWorkerForScope.mockRejectedValueOnce(new Error("busy"));
    h.change();
    for (const [i, delay] of [100, 400, 1_600].entries()) {
      await tick(delay - 1);
      expect(h.startWorkerForScope).toHaveBeenCalledTimes(i + 1);
      await tick(1);
      expect(h.startWorkerForScope).toHaveBeenCalledTimes(i + 2);
    }
    expect(h.logger.warn).toHaveBeenCalledExactlyOnceWith({ scope }, expect.stringContaining("three retries"));
    await tick(60_000);
    expect(h.startWorkerForScope).toHaveBeenCalledTimes(4);
    h.change();
    await tick();
    expect(h.worker.send).toHaveBeenCalledTimes(1);
    await h.manager.quitAll();
  });

  it("SW-10/12a/13: inactive NACK reacquires the worker before dispatching the next event", async () => {
    const h = setup([seed()]);
    const active = workerPort(8);
    h.startWorkerForScope.mockResolvedValueOnce(h.worker).mockResolvedValue(active);
    h.change("first");
    h.change("second");
    await tick();
    const inactive = h.ref();
    h.manager.nack({ ...inactive, versionId: 8 });
    expect(h.worker.ends[0]).not.toHaveBeenCalled();
    h.manager.nack(inactive);
    expect(h.worker.ends[0]).toHaveBeenCalledTimes(1);
    await tick(99);
    expect(active.send).not.toHaveBeenCalled();
    await tick(1);
    expect(active.send.mock.calls.map(([e]) => e.changed[0].value)).toEqual(["first"]);
    h.manager.ack(inactive);
    expect(active.ends[0]).not.toHaveBeenCalled();
    h.manager.started({ versionId: 8, eventId: active.send.mock.calls[0][0].eventId });
    await tick();
    expect(active.send.mock.calls.map(([e]) => e.changed[0].value)).toEqual(["first", "second"]);
    await h.manager.quitAll();
  });

  it("SW-12/13: ordered dispatch uses independent tasks and version-bound idempotent ACKs", async () => {
    const h = setup([seed()]);
    h.change("A");
    h.change("B");
    await tick();
    expect(h.worker.send).toHaveBeenCalledTimes(1);
    expect(h.worker.startTask.mock.invocationCallOrder[0]).toBeLessThan(h.worker.send.mock.invocationCallOrder[0]);
    h.manager.started(h.ref());
    await tick();
    expect(h.worker.send.mock.calls.map(([e]) => e.changed[0].value)).toEqual(["A", "B"]);
    expect(h.ref(1).eventId).not.toBe(h.ref().eventId);
    h.manager.ack({ ...h.ref(), versionId: 8 });
    h.manager.ack(h.ref(1));
    h.manager.ack(h.ref(1));
    expect(h.worker.ends[1]).toHaveBeenCalledTimes(1);
    expect(h.worker.ends[0]).not.toHaveBeenCalled();
    h.manager.ack(h.ref());
    h.manager.workerDestroyed(7);
    await h.manager.quitAll();
    expect(h.worker.ends[0]).toHaveBeenCalledTimes(1);
    expect(h.worker.ends[1]).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("SW-13: B's cookiechange handler settles A's waitUntil and both native tasks end normally", async () => {
    const h = setup([seed()]);
    const serviceWorker = {};
    class ChangeEvent extends Event {
      declare waitUntil: (value: Promise<void>) => void;
      readonly changed;
      constructor(type: string, init: CookieChangeEventInit) {
        super(type);
        this.changed = init.changed;
      }
    }
    // The installer captures the native ServiceWorkerRegistration.prototype.active getter.
    class Registration {
      readonly scope = scope;
      readonly cookies = { getSubscriptions: async () => [{ name: "x" }] };
      get active() {
        return serviceWorker;
      }
    }
    const worker = Object.assign(new EventTarget(), {
      registration: new Registration(),
      serviceWorker,
      ExtendableCookieChangeEvent: ChangeEvent,
    });
    const untilB = deferred<void>();
    const seen: string[] = [];
    worker.addEventListener("cookiechange", (event) => {
      if (!(event instanceof ChangeEvent)) throw new Error("Expected cookiechange");
      const value = event.changed?.[0]?.value;
      if (value === "A") event.waitUntil(untilB.promise);
      if (value === "B") untilB.resolve();
      seen.push(String(value));
    });
    const ref = (eventId: string) => ({ versionId: h.worker.versionId, eventId });
    const bridge: WorkerEventBridge = {
      listen(deliver) {
        h.worker.send.mockImplementation(({ eventId, changed }) => {
          const items = changed.map((item) => ({
            ...item,
            domain: null,
            secure: true,
            partitioned: false as const,
            sameSite: "strict" as const,
          }));
          deliver({ eventId, changed: items, deleted: [] });
        });
      },
      started: (id) => h.manager.started(ref(id)),
      nack: (id) => h.manager.nack(ref(id)),
      ack: (id) => h.manager.ack(ref(id)),
    };
    vi.stubGlobal("self", worker);
    vi.stubGlobal("ServiceWorkerRegistration", Registration);
    vi.stubGlobal("reportError", (error: unknown) => {
      throw error;
    });
    try {
      installWorkerEvents(bridge);
      h.change("A");
      await tick();
      expect(seen).toEqual(["A"]);
      expect(h.worker.ends[0]).not.toHaveBeenCalled();
      h.change("B");
      await tick();
      expect(seen).toEqual(["A", "B"]);
      expect(h.worker.ends.map((end) => end.mock.calls.length)).toEqual([1, 1]);
      expect(h.worker.finish).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllGlobals();
      await h.manager.quitAll();
    }
  });

  it("SW-12/12b: at five minutes sends finish to the same version and releases only the expired task", async () => {
    const h = setup([seed()]);
    h.change();
    await tick();
    h.manager.started(h.ref());
    await tick(1);
    h.change();
    await tick(299_998);
    expect(h.worker.finish).not.toHaveBeenCalled();
    expect(h.worker.ends[0]).not.toHaveBeenCalled();
    await tick(1);
    expect(h.worker.finish).toHaveBeenCalledExactlyOnceWith(h.ref().eventId);
    expect(h.worker.ends[0]).toHaveBeenCalledTimes(1);
    expect(h.worker.ends[1]).not.toHaveBeenCalled();
    h.manager.ack(h.ref());
    h.manager.workerDestroyed(7);
    expect(h.worker.ends[0]).toHaveBeenCalledTimes(1);
    expect(h.worker.ends[1]).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(h.worker.finish).toHaveBeenCalledTimes(1);
  });

  it("SW-12: send failure releases once; worker destruction and quit release only outstanding tasks", async () => {
    const h = setup([seed()]);
    h.worker.send.mockImplementationOnce(() => {
      throw new Error("send failed");
    });
    h.change("failed");
    h.change("sent");
    await tick();
    expect(h.worker.ends[0]).toHaveBeenCalledTimes(1);
    expect(h.worker.ends[1]).not.toHaveBeenCalled();
    h.manager.workerDestroyed(8);
    expect(h.worker.ends[1]).not.toHaveBeenCalled();
    h.manager.workerDestroyed(7);
    h.manager.ack(h.ref(1));
    expect(h.worker.ends[1]).toHaveBeenCalledTimes(1);
    const replacement = workerPort(8);
    h.startWorkerForScope.mockResolvedValue(replacement);
    h.change("replacement");
    await tick();
    h.change("queued at quit");
    await h.manager.quitAll();
    await h.manager.quitAll();
    h.change("after quit");
    await tick(300_000);
    expect(replacement.ends[0]).toHaveBeenCalledTimes(1);
    expect(replacement.send).toHaveBeenCalledTimes(1);
    expect(replacement.finish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
