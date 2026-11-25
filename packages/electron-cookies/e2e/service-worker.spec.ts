import type { ObservedCookie } from "./app/service-worker.mts";
import { expect, test } from "./fixture.ts";
import {
  command,
  observe,
  register,
  scope,
  script,
  waitForChanges,
  windowSubscriptions,
  write,
} from "./service-worker-fixture.ts";

test("SW-01/03/04/14 | a top-level read uses the script path; worker and window share writes", async ({ fixture }) => {
  const reads = [];
  const startups = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site, scope + "page");
    await fixture.set(["visibility=script; Path=/scripts", "visibility=scope; Path=/area"]);
    const reg = await register(fixture.page);
    expect(reg).toEqual({
      scope: fixture.origins[site] + scope,
      script: fixture.origins[site] + script + "?version=A",
      state: "activated",
    });
    const startup = await command(fixture.page, { kind: "startup" });
    startups.push(startup);
    expect(startup).toEqual({
      nativeStore: true,
      visible: [
        {
          name: "visibility",
          value: "script",
          path: "/scripts",
          domain: null,
          expires: null,
          secure: false,
          sameSite: "lax",
          partitioned: false,
        },
      ],
    });
    expect(await fixture.page.evaluate(async () => (await cookieStore.get("visibility"))?.value)).toBe("scope");
    reads.push(await command(fixture.page, { kind: "get", name: "visibility" }));
    await write(fixture.page, "shared", "window");
    expect(await command(fixture.page, { kind: "get", name: "shared" })).toMatchObject({ value: "window" });
    await command(fixture.page, { kind: "set", name: "shared", value: "worker" });
    expect(await fixture.page.evaluate(async () => (await cookieStore.get("shared"))?.value)).toBe("worker");
  }
  expect(startups[1]).toStrictEqual(startups[0]);
  expect(reads[1]).toEqual(reads[0]);
});

test("SW-05 | a native HTTPS worker keeps its cookie store and cannot invoke the jar reader", async ({ fixture }) => {
  await write(fixture.page, "private-probe", "jar");
  await fixture.visit("https");
  await register(fixture.page);
  expect(await command(fixture.page, { kind: "startup" })).toMatchObject({ nativeStore: true });
  expect(await command(fixture.page, { kind: "get", name: "private-probe" })).toBeNull();
  const result = await fixture.app.evaluate(
    (_e, url) => globalThis.cookieFixture.workers.probe(url),
    fixture.origins.https + scope,
  );
  if (result && typeof result === "object" && "error" in result) {
    expect(result.error).toMatch(/No handler registered for 'fixture:cookie-store:get-all'/);
  } else {
    expect(result).toMatchObject({ reply: { ok: false, error: { name: "SecurityError" } } });
  }
});

test("SW-06 | subscribe and unsubscribe across contexts use the registration scope on both sites", async ({
  fixture,
}) => {
  const { page } = fixture;
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await register(page);
    const url = fixture.origins[site] + scope;
    const one = [{ name: "window", url }];
    expect(await windowSubscriptions(page, "subscribe", "window")).toEqual(one);
    expect(await command(page, { kind: "subscriptions" })).toEqual(one);
    const two = [...one, { name: "worker", url }];
    expect(await command(page, { kind: "subscribe", name: "worker" })).toEqual(expect.arrayContaining(two));
    const both = await windowSubscriptions(page, "list");
    expect(both).toHaveLength(2);
    expect(both).toEqual(expect.arrayContaining(two));
    expect(await command(page, { kind: "unsubscribe", name: "window" })).toEqual([two[1]]);
    expect(await windowSubscriptions(page, "unsubscribe", "worker")).toEqual([]);
    expect(await command(page, { kind: "subscriptions" })).toEqual([]);
  }
});

test("SW-07 | native and jar cookiechange dictionaries agree for matching writes and deletions", async ({
  fixture,
}) => {
  const { page } = fixture;
  const results = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await observe(page);
    await register(page);
    await windowSubscriptions(page, "subscribe", "watch", "fence");
    await fixture.set([
      "other=no; Path=/",
      "watch=no; Path=/scripts",
      "watch=visible; Secure; SameSite=Lax; Path=/area",
    ]);
    await waitForChanges(page, 1);
    await fixture.set(["watch=; Max-Age=0; Secure; Path=/area"]);
    await waitForChanges(page, 2);
    await write(page, "fence", "end");
    const changes = await waitForChanges(page, 3);
    expect(changes.map((e) => [e.changed.map((c) => c.value), e.deleted.map((c) => c.name)])).toEqual([
      [["visible"], []],
      [[], ["watch"]],
      [["end"], []],
    ]);
    expect(changes.every((e) => e.instance)).toBe(true);
    results.push(changes.map(({ changed, deleted }) => ({ changed, deleted })));
  }
  expect(results[1]).toStrictEqual(results[0]);
});

test("SW-02, SRV-07/09 | worker credentials, initiator and a controlled fetch reissued with include", async ({
  fixture,
}) => {
  const { page, app } = fixture;
  await register(page);
  await fixture.visit("jar", scope + "page");
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain(script);
  await fixture.set(["sid=trusted; Secure; Path=/"]);
  for (const credentials of ["omit", "same-origin"] as const) {
    const url = await fixture.replyPath(["response=" + credentials + "; Path=/"]);
    const cookie = credentials === "omit" ? "" : "sid=trusted";
    expect(await command(page, { kind: "fetch", url, credentials })).toEqual({ status: 200, body: cookie });
    expect(await app.evaluate((_e, p) => globalThis.cookieFixture.observation(p), url)).toEqual({
      reached: true,
      cookie,
      initiator: fixture.origins.jar,
    });
    expect(await app.evaluate((_e, p) => globalThis.cookieFixture.network(p), url)).toEqual({
      marker: credentials === "omit" ? "1" : null,
      wire: [{ method: "GET", marker: null }],
    });
    expect(await page.evaluate(async () => (await cookieStore.get("response"))?.value ?? null)).toBe(
      credentials === "omit" ? null : credentials,
    );
  }
  const url = await fixture.replyPath(["via=worker; Path=/"], "/reissue");
  const response = await page.evaluate(async (path) => {
    const res = await fetch(path, { credentials: "omit" });
    return {
      status: res.status,
      body: (await res.text()).split("; ").toSorted(),
      credentials: res.headers.get("x-fixture-original-credentials"),
      marker: res.headers.get("x-fixture-original-marker"),
    };
  }, url);
  expect(response).toEqual({
    status: 200,
    body: ["response=same-origin", "sid=trusted"],
    credentials: "omit",
    marker: "1",
  });
  expect(await app.evaluate((_e, p) => globalThis.cookieFixture.network(p), url)).toEqual({
    marker: null,
    wire: [{ method: "GET", marker: null }],
  });
  expect(await page.evaluate(async () => (await cookieStore.get("via"))?.value)).toBe("worker");
});

for (const registrationScope of [scope, "/"]) {
  test(
    "SW-03 | read URL resolution, filtering and errors with registration " + registrationScope,
    async ({ fixture }) => {
      const results = [];
      for (const site of ["https", "jar"] as const) {
        await fixture.visit(site);
        const { page } = fixture;
        await register(page, "", "active", registrationScope);
        await fixture.set([
          "visibility=scope; Path=/area",
          "visibility=script; Path=/scripts",
          "visibility=nested; Path=" + script + "/nested",
        ]);
        const urls = [
          script,
          "#fragment",
          "./service-worker.js",
          "child",
          "child/../service-worker.js",
          "./service-worker.js-suffix",
          "./service-worker.js/nested/page#part",
          "/area/",
          "/area/sub/page",
          "../area/page",
          "/outside/",
          "https://foreign.test/",
          "https://[",
        ];
        const rows = [];
        for (const method of ["get", "getAll"] as const) {
          for (const url of urls) {
            rows.push({
              method,
              url,
              result: await command(page, { kind: "read-url", method, url, record: true }, "active", registrationScope),
            });
          }
        }
        await test.info().attach(site + " worker URL results", {
          body: JSON.stringify(rows, null, 2),
          contentType: "application/json",
        });
        results.push(rows);
      }
      expect(results[1]).toStrictEqual(results[0]);
      const [native] = results;
      expect(native.find((r) => r.method === "get" && r.url === "./service-worker.js")?.result).toMatchObject({
        value: "script",
      });
      expect(
        native.find((r) => r.method === "getAll" && r.url === "./service-worker.js/nested/page#part")?.result,
      ).toMatchObject([{ value: "nested" }, { value: "script" }]);
    },
  );
}

test("SW-03 | a script-prefix URL outside the registration returns the same path cookie on both sites", async ({
  fixture,
}) => {
  const results = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await register(fixture.page, "");
    await fixture.set(["visibility=outside-area; Path=" + script + "/nested"]);
    const reply = await command(fixture.page, {
      kind: "read-url",
      method: "get",
      url: script + "/nested/page",
      record: true,
    });
    results.push(reply);
  }
  expect(results[0]).toMatchObject({ value: "outside-area", path: script + "/nested" });
  expect(results[1]).toStrictEqual(results[0]);
});

test("SW-03 | set and delete ignore url and preserve default and empty paths", async ({ fixture }) => {
  const results = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await register(fixture.page);
    const rows = [];
    for (const [name, path] of [
      ["default", undefined],
      ["empty", ""],
    ] as const) {
      for (const method of ["set", "delete"] as const) {
        const outcome = await command(fixture.page, {
          kind: "write-url",
          method,
          url: "https://foreign.test/ignored",
          name,
          path,
          record: true,
        });
        const cookie = await command(fixture.page, { kind: "get", name });
        if (method === "set")
          expect(cookie).toMatchObject({ value: "written", path: path === undefined ? "/" : "/scripts" });
        else expect(cookie).toBeNull();
        rows.push({ method, name, outcome, cookie });
      }
    }
    results.push(rows);
  }
  expect(results[1]).toStrictEqual(results[0]);
});

test("SW-06 | wildcard and URL subscriptions resolve against the registration from either context", async ({
  fixture,
}) => {
  const results = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site, "/client/page");
    const { page } = fixture;
    await register(page);
    const rows = [];
    for (const context of ["worker", "window"] as const) {
      for (const entry of [
        {},
        { url: "/area/deep/page" },
        { name: "watch", url: "relative/page" },
        { url: "../outside" },
      ]) {
        for (const kind of ["subscribe", "unsubscribe"] as const) {
          const result =
            context === "worker"
              ? await command(page, { kind, entries: [entry], record: true })
              : await page.evaluate(
                  async ({ scopeUrl, operation, subscription }) => {
                    const registration = await navigator.serviceWorker.getRegistration(scopeUrl);
                    if (!registration) throw new Error("Missing registration");
                    try {
                      await registration.cookies[operation]([subscription]);
                      return await registration.cookies.getSubscriptions();
                    } catch (error) {
                      if (!(error instanceof Error)) throw error;
                      return { error: { name: error.name, message: error.message } };
                    }
                  },
                  { scopeUrl: scope, operation: kind, subscription: entry },
                );
          // Only this registration's origin varies. Preserve subscription order and missing fields.
          const subscriptions = await windowSubscriptions(page, "list");
          const normalize = (value: unknown) =>
            Array.isArray(value)
              ? value.map((subscription: CookieStoreGetOptions) => {
                  const origin = fixture.origins[site];
                  return subscription.url?.startsWith(origin + "/")
                    ? { ...subscription, url: subscription.url.slice(origin.length) }
                    : subscription;
                })
              : value;
          rows.push({ context, kind, entry, result: normalize(result), subscriptions: normalize(subscriptions) });
        }
      }
    }
    results.push(rows);
  }
  expect(results[1]).toStrictEqual(results[0]);
});

test("SW-07 | wildcard, parent path, domain, HttpOnly and expiry changes reach oncookiechange", async ({ fixture }) => {
  const expires = Math.floor(Date.now() / 1000) * 1000 + 3600_000;
  const results = [];
  for (const site of ["https", "jar"] as const) {
    const { page } = fixture;
    await fixture.visit(site);
    await observe(page);
    await register(page);
    await command(page, { kind: "subscribe", entries: [{}] });
    await write(page, "wildcard-only", "visible");
    await waitForChanges(page, 1);
    await command(page, { kind: "unsubscribe", entries: [{}] });
    await command(page, { kind: "subscribe", entries: [{ url: "/area/deep/page" }] });
    await fixture.set(["hidden=yes; Path=/; HttpOnly", "sibling=no; Path=/area/deeper"]);
    expect(await fixture.stored(site)).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "hidden", httpOnly: true })]),
    );
    await page.evaluate(() =>
      cookieStore.set({ name: "parent", value: "visible", domain: location.hostname, path: "/" }),
    );
    await waitForChanges(page, 2);
    await page.evaluate(async (expiry) => {
      const initial = { name: "parent", value: "visible", domain: location.hostname, path: "/" };
      await cookieStore.set(initial);
      await cookieStore.set({ ...initial, expires: expiry });
    }, expires);
    await write(page, "fence", "end");
    await page.waitForFunction(() => window.swChanges.some((event) => event.changed.some((c) => c.name === "fence")));
    const changes = await page.evaluate(() => window.swChanges);
    const hostname = new URL(fixture.origins[site]).hostname;
    const normalize = (c: ObservedCookie) => (c.domain === hostname ? { ...c, domain: "HOST" } : c);
    results.push({
      events: changes.map(({ changed, deleted }) => ({
        changed: changed.map(normalize),
        deleted: deleted.map(normalize),
      })),
      propertyEvents: await command(page, { kind: "property-events" }),
    });
  }
  expect(results[1]).toStrictEqual(results[0]);
  const [{ events, propertyEvents }] = results;
  const names = events.flatMap((event) => event.changed.map((c) => c.name));
  expect(names).toEqual(["wildcard-only", "parent", "parent", "fence"]);
  expect(propertyEvents).toEqual(names);
  expect(events[1].changed[0].domain).toBe("HOST");
  expect(events[2].changed[0].expires).toBe(expires);
});
