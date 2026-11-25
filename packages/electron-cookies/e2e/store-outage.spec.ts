import { SYNC_STORE_PROBE_TIMEOUT_MS, SYNC_STORE_TIMEOUT_MS } from "../src/ipc.ts";
import { expect, requestCookie, test, type Fixture } from "./fixture.ts";

/** Interpose only on script store reads and one test cookie's write. Server traffic and
 * Chromium change notifications continue through the real store while a read is pending. */
async function storeGate({ app }: Fixture) {
  return app.evaluateHandle(({ session }) => {
    const store = session.defaultSession.cookies;
    // oxlint-disable-next-line typescript/unbound-method -- Restore the original methods with their receiver.
    const { get, set } = store;
    let gate: Promise<void> | undefined;
    let release: (() => void) | undefined;
    const completed: string[] = [];
    let reads = 0,
      writes = 0;
    store.get = async (filter) => {
      if (filter.httpOnly !== false) return get.call(store, filter);
      if (gate) {
        reads++;
        await gate;
      }
      const rows = await get.call(store, filter);
      const lang = rows.find((c) => c.name === "lang")?.value ?? "";
      // The snapshot consumes the resolved get in microtasks before the next main-process turn.
      setImmediate(() => completed.push(lang));
      return rows;
    };
    store.set = async (details) => {
      if (gate && details.name === "during") {
        writes++;
        await gate;
      }
      await set.call(store, details);
    };
    return {
      pause() {
        gate = new Promise<void>((r) => {
          release = r;
        });
      },
      completed,
      counts: () => ({ reads, writes }),
      resume() {
        gate = undefined;
        release?.();
      },
      restore() {
        store.get = get;
        store.set = set;
        gate = undefined;
        release?.();
      },
    };
  });
}

test("DC-16/16a, CS-14 | synchronous deadlines, cooldown and recovery while a structured read is stalled", async ({
  fixture,
}) => {
  const { page } = fixture;
  await fixture.set(["lang=zh; Path=/"]);
  expect(await page.evaluate(() => document.cookie)).toBe("lang=zh");
  const cold = await fixture.peer("jar", "/uncached/page");
  const fault = await storeGate(fixture);
  try {
    await fault.evaluate((f) => f.pause());
    const pending = page.evaluate(async () => {
      try {
        await cookieStore.getAll();
        return "resolved";
      } catch (err) {
        return err instanceof DOMException ? err.name : String(err);
      }
    });
    await expect.poll(() => fault.evaluate((f) => f.counts().reads)).toBeGreaterThan(0);
    const first = await page.evaluate(() => {
      const start = performance.now();
      return { text: document.cookie, ms: performance.now() - start };
    });
    expect(first.text).toBe("lang=zh");
    expect(first.ms).toBeGreaterThanOrEqual(SYNC_STORE_TIMEOUT_MS - 20);
    expect(first.ms).toBeLessThan(SYNC_STORE_TIMEOUT_MS + 500);
    const probe = await cold.evaluate(() => {
      const start = performance.now();
      document.cookie = "during=pending; Path=/";
      return { text: document.cookie, ms: performance.now() - start };
    });
    expect(probe.text).toBe("");
    expect(probe.ms).toBeLessThan(2 * SYNC_STORE_PROBE_TIMEOUT_MS + 300);
    expect(await fault.evaluate((f) => f.counts().writes)).toBe(1);
    expect(await pending).toBe("TimeoutError");
    await fault.evaluate((f) => f.resume());
    await expect.poll(() => page.evaluate(() => document.cookie)).toContain("during=pending");
    expect(await page.evaluate(async () => (await cookieStore.get("lang"))?.value)).toBe("zh");
    await fault.evaluate((f) => f.pause());
    const recoveredBudget = await page.evaluate(() => {
      const start = performance.now();
      const text = document.cookie;
      return { text, ms: performance.now() - start };
    });
    expect(recoveredBudget.text).toContain("during=pending");
    expect(recoveredBudget.ms).toBeGreaterThanOrEqual(SYNC_STORE_TIMEOUT_MS - 20);
  } finally {
    await fault.evaluate((f) => f.restore());
    await fault.dispose();
    await cold.close();
  }
  expect(await requestCookie(page)).toContain("during=pending");
});

for (const change of ["lang=en; Path=/", "lang=gone; Path=/; Max-Age=0", "lang=secret; HttpOnly; Path=/"]) {
  test("DC-16b | snapshot follows completed server refresh: " + change, async ({ fixture }) => {
    const { page } = fixture;
    await fixture.set(["lang=zh; Path=/"]);
    expect(await page.evaluate(() => document.cookie)).toBe("lang=zh");
    const fault = await storeGate(fixture);
    const expected = change.startsWith("lang=en") ? "en" : "";
    try {
      await fault.evaluate((f) => f.pause());
      await fixture.set([change]);
      // No foreground read since installing the gate: this call came from the background refresh.
      await expect.poll(() => fault.evaluate((f) => f.counts().reads)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.cookie)).toBe("lang=zh");
      await fault.evaluate((f) => f.resume());
      await expect.poll(() => fault.evaluate((f) => f.completed)).toContain(expected);
      await fault.evaluate((f) => f.pause());
      expect(await page.evaluate(() => document.cookie)).toBe(expected ? "lang=en" : "");
    } finally {
      await fault.evaluate((f) => f.restore());
      await fault.dispose();
    }
    expect(await page.evaluate(() => document.cookie)).toBe(expected ? "lang=en" : "");
  });
}

test("DC-16 | a crashed network service loses unflushed and in-flight script writes", async ({ fixture }) => {
  test.skip(
    process.platform === "win32",
    "Suspending the owned network service before the in-flight write requires SIGSTOP",
  );
  const { app, page } = fixture;
  await fixture.set(["durable=before; Path=/; Max-Age=3600"]);
  // The response above flushes the baseline. Suspend only this launch's network service on
  // the next designated write, submit it over Mojo, then kill the service before it can reply.
  const fault = await app.evaluateHandle(({ app: main, session }) => {
    const store = session.defaultSession.cookies;
    // oxlint-disable-next-line typescript/unbound-method -- Restore the exact method and call it with its original receiver.
    const set = store.set;
    let submitted = false;
    store.set = (details) => {
      if (details.name !== "inflight") return set.call(store, details);
      const service = main
        .getAppMetrics()
        .find(
          (m) =>
            m.type === "Utility" && (m.serviceName === "network.mojom.NetworkService" || m.name === "Network Service"),
        );
      if (!service) throw new Error("Fixture network service missing");
      process.kill(service.pid, "SIGSTOP");
      try {
        const pending = set.call(store, details);
        submitted = true;
        return pending;
      } finally {
        process.kill(service.pid, "SIGKILL");
      }
    };
    return {
      submitted: () => submitted,
      restore() {
        store.set = set;
      },
    };
  });
  try {
    const before = await page.evaluate(() => {
      document.cookie = "unflushed=old; Path=/; Max-Age=3600";
      const visible = document.cookie;
      document.cookie = "inflight=old; Path=/; Max-Age=3600";
      return visible;
    });
    expect(before.split("; ")).toContain("unflushed=old");
    expect(await fault.evaluate((f) => f.submitted())).toBe(true);
  } finally {
    await fault.evaluate((f) => f.restore());
    await fault.dispose();
  }
  // Reads sent during Chromium's restart can time out. A successful empty/stale read still
  // fails the assertion. The async API cannot serve the synchronous last-good snapshot.
  await expect(async () => {
    const names = await page.evaluate(async () => (await cookieStore.getAll()).map((cookie) => cookie.name));
    expect(names).toEqual(["durable"]);
  }).toPass({ timeout: 15_000 });
  await page.evaluate(() => cookieStore.set("inflight", "recovered"));
  expect(await requestCookie(page)).toBe("durable=before; inflight=recovered");
});
