import type { WorkerGate } from "./app/worker-controls.ts";
import { expect, type Fixture, test } from "./fixture.ts";
import {
  command,
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
