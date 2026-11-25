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
    expect(startup).toMatchObject({ visible: [{ name: "visibility", value: "script", path: "/scripts" }] });
    expect(await fixture.page.evaluate(async () => (await cookieStore.get("visibility"))?.value)).toBe("scope");
    reads.push(await command(fixture.page, { kind: "get", name: "visibility" }));
    await write(fixture.page, "shared", "window");
    expect(await command(fixture.page, { kind: "get", name: "shared" })).toMatchObject({ value: "window" });
    await command(fixture.page, { kind: "set", name: "shared", value: "worker" });
    expect(await fixture.page.evaluate(async () => (await cookieStore.get("shared"))?.value)).toBe("worker");
  }
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
  expect(results[1]).toEqual(results[0]);
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
