import type { WorkerGate } from "./app/worker-controls.ts";
import { compareNative, expect, type Fixture, test } from "./fixture.ts";
import {
  command,
  detachWorkerDebuggers,
  index,
  observe,
  register,
  running,
  scope,
  deliveryState,
  waitForChanges,
  windowSubscriptions,
  write,
} from "./service-worker-fixture.ts";

function arm(fixture: Fixture, gate: WorkerGate) {
  return fixture.app.evaluate((_e, point) => globalThis.cookieFixture.workers.arm(point), gate);
}
async function reached(fixture: Fixture) {
  await expect.poll(() => fixture.app.evaluate(() => globalThis.cookieFixture.workers.reached())).toBe(true);
}
function release(fixture: Fixture) {
  return fixture.app.evaluate(() => globalThis.cookieFixture.workers.release());
}

test("SW-08 | a stopped registration wakes on a matching change, including the first change after clean restart", async ({
  fixture,
  restart,
}) => {
  const { page } = fixture;
  await observe(page);
  const registration = await register(page);
  await windowSubscriptions(page, "subscribe", "wake");
  const cdp = await page.context().newCDPSession(page);
  try {
    let versionId = "";
    cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
      const active = versions.find(
        (v) => v.scriptURL === registration.script && v.status === "activated" && v.runningStatus === "running",
      );
      if (active) versionId = active.versionId;
    });
    await cdp.send("ServiceWorker.enable");
    await expect.poll(() => versionId, { message: "CDP running version for " + registration.script }).not.toBe("");
    await cdp.send("ServiceWorker.stopWorker", { versionId });
  } finally {
    await cdp.detach();
  }
  await expect.poll(() => running(fixture)).toEqual([]);
  await write(page, "wake", "after-stop");
  expect(await waitForChanges(page, 1)).toMatchObject([{ changed: [{ value: "after-stop" }] }]);
  const next = await restart("quit");
  await observe(next.page);
  expect(await running(next)).toEqual([]);
  await write(next.page, "wake", "after-restart");
  expect(await waitForChanges(next.page, 1)).toMatchObject([{ changed: [{ value: "after-restart" }] }]);
});

for (const point of ["index-written", "native-complete"] as const) {
  test(
    "SW-08 | hard kill at " + point + " retains the hint; native subscriptions determine first delivery",
    async ({ fixture, restart }) => {
      // The launch page is outside the scope. Observing a BroadcastChannel cannot wake the worker.
      await register(fixture.page);
      await arm(fixture, point);
      const child = fixture.app.process();
      const subscribe = windowSubscriptions(fixture.page, "subscribe", "crash").then(
        () => ({ status: "resolved" }),
        (error: unknown) => ({ status: "rejected", error }),
      );
      try {
        await Promise.race([
          reached(fixture),
          subscribe.then((result) => {
            if ("error" in result) throw result.error;
            throw new Error("Subscribe completed before the crash gate");
          }),
        ]);
        expect(await index(fixture)).toMatchObject([{ name: "crash", scope: fixture.origins.jar + scope }]);
        const next = await restart("kill");
        expect(await subscribe).toMatchObject({ status: "rejected" });
        await observe(next.page);
        expect(await running(next)).toEqual([]);
        await write(next.page, "crash", "first");
        await expect.poll(() => deliveryState(next)).toEqual({ wakes: 1, pending: 0 });
        if (point === "native-complete") {
          expect(await waitForChanges(next.page, 1)).toMatchObject([{ changed: [{ value: "first" }] }]);
        } else {
          expect(await windowSubscriptions(next.page, "list")).toEqual([]);
          await windowSubscriptions(next.page, "subscribe", "crash");
          await write(next.page, "crash", "subscribed");
          expect(await waitForChanges(next.page, 1)).toMatchObject([{ changed: [{ value: "subscribed" }] }]);
          expect(await command(next.page, { kind: "events" })).toMatchObject([{ changed: [{ value: "subscribed" }] }]);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) await release(fixture);
      }
    },
  );
}

test("SW-09 | unregister drops A's queued events; B keeps its first subscription time on repeat", async ({
  fixture,
}) => {
  const { page } = fixture;
  await register(page);
  await observe(page);
  await windowSubscriptions(page, "subscribe", "same");
  const [a] = await index(fixture);
  await arm(fixture, "wake");
  try {
    await write(page, "same", "in-flight-A");
    await reached(fixture);
    await write(page, "same", "queued-A");
    await expect
      .poll(() => fixture.app.evaluate(() => globalThis.cookieFixture.workers.observedWrites))
      .toContain("queued-A");
    const unregistered = await page.evaluate(
      async (target) => (await navigator.serviceWorker.getRegistration(target))?.unregister(),
      scope,
    );
    expect(unregistered).toBe(true);
    expect(await index(fixture)).toEqual([]);
    await register(page, "B");
    expect(await windowSubscriptions(page, "list")).toEqual([]);
    await write(page, "same", "before-B-subscribe");
    await expect
      .poll(() => fixture.app.evaluate(() => globalThis.cookieFixture.workers.observedWrites))
      .toContain("before-B-subscribe");
    await windowSubscriptions(page, "subscribe", "same");
    const [b] = await index(fixture);
    expect(b.since).toBeGreaterThan(a.since);
    await write(page, "same", "first-B");
    await command(page, { kind: "subscribe", name: "same" });
    expect(await index(fixture)).toEqual([b]);
  } finally {
    await release(fixture);
  }
  expect(await waitForChanges(page, 1)).toMatchObject([{ version: "B", changed: [{ value: "first-B" }] }]);
  expect(await command(page, { kind: "events" })).toMatchObject([{ version: "B", changed: [{ value: "first-B" }] }]);
});

test("SW-12a | external unregister shares one wake schedule and the replacement receives the next change", async ({
  fixture,
}) => {
  const { page, app } = fixture;
  const registration = await register(page);
  await windowSubscriptions(page, "subscribe", "outage");
  const hints = await index(fixture);
  expect(hints).toMatchObject([{ scope: registration.scope, name: "outage", eligible: true }]);
  // The fixture page is outside /area/. Remove its registration in Chromium without calling the page shim.
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.unregister", { scopeURL: registration.scope });
    await expect
      .poll(() =>
        page.evaluate(async (url) => (await navigator.serviceWorker.getRegistration(url))?.scope, registration.scope),
      )
      .toBeUndefined();
  } finally {
    await cdp.detach();
  }
  expect(await index(fixture)).toEqual(hints);

  async function burstDuringWake(values: string[]) {
    await arm(fixture, "wake");
    try {
      await write(page, "outage", values[0]);
      await reached(fixture);
      await page.evaluate(async (rest) => {
        for (const value of rest) await cookieStore.set("outage", value);
      }, values.slice(1));
      // Main has seen every write in this burst before the native wake can settle.
      await expect
        .poll(() =>
          app.evaluate((_e, length) => globalThis.cookieFixture.workers.observedWrites.slice(-length), values.length),
        )
        .toEqual(values);
    } finally {
      await release(fixture);
    }
  }

  await burstDuringWake(Array.from({ length: 17 }, (_, i) => "offline-" + i));
  await expect.poll(() => app.evaluate(() => globalThis.cookieFixture.workers.failedWakes)).toBe(4);
  expect(await app.evaluate(() => globalThis.cookieFixture.workers.wakeAttempts.length)).toBe(4);
  expect(await index(fixture)).toEqual(hints);

  await register(page, "B");
  expect(await windowSubscriptions(page, "list")).toEqual([]);
  await windowSubscriptions(page, "subscribe", "outage");
  await observe(page);
  await write(page, "outage", "recovered");
  expect(await waitForChanges(page, 1)).toMatchObject([{ version: "B", changed: [{ value: "recovered" }] }]);
  expect(await app.evaluate(() => globalThis.cookieFixture.workers.wakeAttempts.length)).toBe(5);

  const burst = Array.from({ length: 140 }, (_, i) => "burst-" + i);
  await burstDuringWake(burst);
  await page.waitForFunction((last) => window.swChanges.at(-1)?.changed[0].value === last, burst.at(-1));
  expect(await page.evaluate(() => window.swChanges.map((event) => event.changed[0].value))).toEqual([
    "recovered",
    ...burst.slice(-128),
  ]);
});

test("SW-09 | eligibility follows main's changed callback when a pre-subscription notification arrives late", async ({
  fixture,
}) => {
  const { page } = fixture;
  await compareNative(
    fixture,
    "/",
    async (site) => {
      await register(page);
      await observe(page);
      await windowSubscriptions(page, "subscribe", "fence");
      if (site === "jar") await arm(fixture, "change-notification");
      try {
        await write(page, "late", "before");
        if (site === "jar") {
          await reached(fixture);
        } else {
          // Fence native processing of the earlier write before subscribing.
          await write(page, "fence", "observed");
          expect(await waitForChanges(page, 1)).toMatchObject([{ changed: [{ name: "fence" }] }]);
        }
        await windowSubscriptions(page, "subscribe", "late");
      } finally {
        if (site === "jar") await release(fixture);
      }
      await write(page, "late", "after");
      await page.waitForFunction(() => window.swChanges.some((e) => e.changed.some((item) => item.value === "after")));
      const values = await page.evaluate(() =>
        window.swChanges.flatMap((e) => e.changed.filter((item) => item.name === "late").map((item) => item.value)),
      );
      if (site !== "jar") expect(values).toEqual(["after"]);
      return values;
    },
    (native) => ["before", ...native],
  );
});

test("SW-12e | losing a granted unregister frame leaves the live registration wake-only until resubscribe", async ({
  fixture,
}) => {
  const { page } = fixture;
  await register(page);
  await observe(page);
  const original = await windowSubscriptions(page, "subscribe", "survivor");
  const peer = await fixture.peer("jar");
  await arm(fixture, "unregister-granted");
  try {
    const unregister = peer
      .evaluate(async (target) => (await navigator.serviceWorker.getRegistration(target))!.unregister(), scope)
      .then(
        () => "returned",
        () => "frame closed",
      );
    await reached(fixture);
    await peer.close();
    expect(await unregister).toBe("frame closed");
    await expect.poll(() => index(fixture)).toMatchObject([{ name: "survivor", eligible: false }]);
  } finally {
    await release(fixture);
  }
  expect(await windowSubscriptions(page, "list")).toEqual(original);
  await write(page, "survivor", "wake-only");
  await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
  await windowSubscriptions(page, "subscribe", "survivor");
  await write(page, "survivor", "restored");
  expect(await waitForChanges(page, 1)).toMatchObject([{ changed: [{ value: "restored" }] }]);
  expect(await command(page, { kind: "events" })).toMatchObject([{ changed: [{ value: "restored" }] }]);
});

test("SW-10 | during update only the active version handles cookiechange", async ({ fixture }) => {
  const { page } = fixture;
  await register(page);
  await fixture.visit("jar", scope + "page");
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain("version=A");
  await observe(page);
  await windowSubscriptions(page, "subscribe", "revision");
  await register(page, "B", "waiting");
  await write(page, "revision", "while-waiting");
  expect(await waitForChanges(page, 1)).toMatchObject([{ version: "A", changed: [{ value: "while-waiting" }] }]);
  await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
  expect(await command(page, { kind: "events" }, "waiting")).toEqual([]);
  // Leaving the only controlled client allows B to activate naturally.
  await fixture.visit("jar");
  await observe(page);
  await expect
    .poll(() =>
      page.evaluate(async (s) => {
        const reg = await navigator.serviceWorker.getRegistration(s);
        return [reg?.active?.scriptURL, reg?.active?.state];
      }, scope),
    )
    .toEqual([fixture.origins.jar + "/scripts/service-worker.js?version=B", "activated"]);
  await write(page, "revision", "after-update");
  expect(await waitForChanges(page, 1)).toMatchObject([{ version: "B", changed: [{ value: "after-update" }] }]);
});

test("SW-11/12/12c | append waitUntil after dispatch; only the last settlement releases the native task", async ({
  fixture,
}) => {
  const { page } = fixture;
  await register(page);
  await observe(page);
  await windowSubscriptions(page, "subscribe", "held");
  expect(await deliveryState(fixture)).toEqual({ wakes: 0, pending: 0 });
  await write(page, "held", "pending");
  expect(await waitForChanges(page, 1)).toMatchObject([{ instance: true, trusted: false }]);
  await command(page, { kind: "append" });
  await command(page, { kind: "release-first" });
  expect(await command(page, { kind: "late" })).toBe("accepted");
  expect(await deliveryState(fixture)).toEqual({ wakes: 1, pending: 1 });
  await command(page, { kind: "release-last" });
  await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
  expect(await command(page, { kind: "late" })).toBe("InvalidStateError");
});

test("SW-12 (slow) | waitUntil keeps the same worker alive across idle termination", async ({ fixture }) => {
  test.setTimeout(150_000);
  const { page } = fixture;
  await observe(page);
  const held = await register(page);
  const control = await register(page, "control", "active", "/control/");
  await windowSubscriptions(page, "subscribe", "held");
  await detachWorkerDebuggers(page.context());

  await write(page, "held", "pending");
  expect(await waitForChanges(page, 1)).toMatchObject([{ changed: [{ name: "held", value: "pending" }] }]);
  const workers = await running(fixture);
  const heldWorker = workers.find((worker) => worker.scope === held.scope);
  expect(heldWorker).toBeDefined();
  expect(workers).toContainEqual(expect.objectContaining({ scope: control.scope }));
  expect(await deliveryState(fixture)).toEqual({ wakes: 1, pending: 1 });

  // Allow a full 30 s idle delay plus a 30 s timer tick, even if the control stops sooner.
  // Only the main process is polled until both conditions hold.
  const started = performance.now();
  const idlePoll = { timeout: 75_000, intervals: [1000] };
  await expect
    .poll(async () => ({ workers: await running(fixture), pastIdleWindow: performance.now() - started >= 65_000 }), {
      ...idlePoll,
      message: "Only the held worker should still be running past the idle window",
    })
    .toEqual({ workers: [heldWorker], pastIdleWindow: true });
  expect(await deliveryState(fixture)).toEqual({ wakes: 1, pending: 1 });
  // A restarted instance has no held event. A finished event rejects a new waitUntil.
  expect(await command(page, { kind: "late" })).toBe("accepted");
  await command(page, { kind: "release-first" });
  await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
  await expect.poll(() => running(fixture), idlePoll).toEqual([]);
});

test.describe("short native task timeout", () => {
  test.use({ taskTimeoutMs: 2000 });
  test("SW-12b | timeout finishes the worker event even while its promise remains pending", async ({ fixture }) => {
    const { page } = fixture;
    await register(page);
    await observe(page);
    await windowSubscriptions(page, "subscribe", "held");
    await write(page, "held", "timeout");
    await waitForChanges(page, 1);
    await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
    await expect.poll(() => command(page, { kind: "late" })).toBe("InvalidStateError");
    await command(page, { kind: "release-first" });
    expect(await deliveryState(fixture)).toEqual({ wakes: 1, pending: 0 });
  });
});

test("SW-13 | A waits for B in the same registration and both native tasks end", async ({ fixture }) => {
  const { page } = fixture;
  await register(page);
  await observe(page);
  await windowSubscriptions(page, "subscribe", "A", "B");
  await write(page, "A", "one");
  await waitForChanges(page, 1);
  expect(await deliveryState(fixture)).toEqual({ wakes: 1, pending: 1 });
  await write(page, "B", "two");
  const changes = await waitForChanges(page, 2);
  expect(changes.map((e) => e.changed[0].name)).toEqual(["A", "B"]);
  expect(changes[0].boot).toBe(changes[1].boot);
  await expect.poll(() => deliveryState(fixture)).toEqual({ wakes: 2, pending: 0 });
  expect(await command(page, { kind: "late" })).toBe("InvalidStateError");
});

test("SW-07/08 | overlapping registrations wake independently and an unmatched stopped worker stays asleep", async ({
  fixture,
}) => {
  const { page } = fixture;
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await observe(page);
    await register(page, "root", "active", "/");
    const area = await register(page, "area");
    await command(page, { kind: "subscribe", entries: [{}] }, "active", "/");
    await command(page, { kind: "subscribe", name: "both" });
    const cdp = await page.context().newCDPSession(page);
    let versionId = "";
    let status = "";
    const starts: string[] = [];
    try {
      cdp.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
        for (const v of versions) {
          if (v.scriptURL !== area.script || v.status !== "activated") continue;
          versionId = v.versionId;
          if (status !== v.runningStatus) starts.push(v.runningStatus);
          status = v.runningStatus;
        }
      });
      await cdp.send("ServiceWorker.enable");
      await expect.poll(() => status).toBe("running");
      await cdp.send("ServiceWorker.stopWorker", { versionId });
      await expect.poll(() => status).toBe("stopped");
      starts.length = 0;
      await write(page, "root-only", "one");
      // The root registration acknowledges this very write, fencing the negative
      // assertion without waking the area worker to poll its own event log.
      const [first] = await waitForChanges(page, 1);
      expect([first.version, first.changed[0].name]).toEqual(["root", "root-only"]);
      expect((await running(fixture)).map((w) => w.scope)).not.toContain(area.scope);
      expect(starts).toEqual([]);
      if (site === "jar") {
        expect(await fixture.app.evaluate(() => globalThis.cookieFixture.workers.wakeAttempts)).toEqual([
          fixture.origins.jar + "/",
        ]);
      }
      await write(page, "both", "two");
      const changes = await waitForChanges(page, 3);
      expect(
        changes
          .slice(1)
          .map((e) => [e.version, e.changed[0].name] as const)
          .toSorted(([a], [b]) => a.localeCompare(b)),
      ).toEqual([
        ["area", "both"],
        ["root", "both"],
      ]);
      await expect.poll(() => status).toBe("running");
    } finally {
      await cdp.detach();
    }
  }
});
