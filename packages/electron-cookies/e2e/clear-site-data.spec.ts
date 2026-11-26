import { compareNative, expect, requestCookie, test } from "./fixture.ts";
import { observe, register, windowSubscriptions } from "./service-worker-fixture.ts";

for (const [header, clears, saves] of [
  ['"unknown", "cookies"', true, false],
  ['"*"', true, false],
  ['cookies, "*broken"', false, true],
  ['"cookies", "é"', false, false],
  ['"unfinished, "cookies"', true, true],
] as const) {
  test("Clear-Site-Data " + header + " with same-response Set-Cookie", async ({ fixture }) => {
    await compareNative(fixture, "/", async (site) => {
      await fixture.set([
        "visible=1; Path=/",
        "hidden=1; HttpOnly; Path=/private",
        "chip=1; Partitioned; Secure; Path=/",
      ]);
      const reply = await fixture.replyPath({ cookies: ["fresh=1; Path=/"], clearSiteData: header });
      if (header === '"*"') {
        await fixture.page.evaluate(() => localStorage.setItem("clear-witness", "before"));
        await fixture.page.goto(fixture.origins[site] + reply);
        expect(await fixture.page.evaluate(() => localStorage.getItem("clear-witness"))).toBe(
          site === "jar" ? "before" : null,
        );
      } else await requestCookie(fixture.page, reply);
      const remaining = (await fixture.stored(site)).map((c) => c.name).toSorted();
      const expected = clears ? [] : ["chip", "hidden", "visible"];
      if (saves) expected.push("fresh");
      expect(remaining).toEqual(expected.toSorted());
      return remaining;
    });
  });
}

for (const operation of ["clear", "overwrite"] as const) {
  test("document and service worker cookie events for " + operation, async ({ fixture }) => {
    await compareNative(fixture, "/", async () => {
      const { page } = fixture;
      await observe(page);
      await register(page);
      await windowSubscriptions(page, "subscribe", "a", "hidden", "fresh", "sentinel");
      await page.evaluate(() => {
        window.observedCookieChanges = [];
        cookieStore.addEventListener("change", (event) => {
          window.observedCookieChanges.push(
            ...event.changed.map((c) => ["changed", c.name, c.value]),
            ...event.deleted.map((c) => ["deleted", c.name, c.value]),
          );
        });
      });
      await fixture.set(["a=1; Path=/", "hidden=1; HttpOnly; Path=/"]);
      if (operation === "clear") {
        await requestCookie(
          page,
          await fixture.replyPath({ cookies: ["fresh=1; Path=/"], clearSiteData: '"cookies"' }),
        );
      } else {
        await fixture.set(["a=2; HttpOnly; Path=/"]);
        expect(await requestCookie(page)).toContain("a=2");
        expect(await page.evaluate(() => cookieStore.get("a"))).toBeNull();
      }
      await fixture.set(["sentinel=1; Path=/"]);
      await page.waitForFunction(
        () =>
          window.observedCookieChanges.some((c) => c[1] === "sentinel") &&
          window.swChanges.some((e) => e.changed.some((c) => c.name === "sentinel")),
      );
      const events = await page.evaluate(() => ({
        window: window.observedCookieChanges,
        worker: window.swChanges.flatMap((e) => [
          ...e.changed.map((c) => ["changed", c.name, c.value]),
          ...e.deleted.map((c) => ["deleted", c.name, c.value]),
        ]),
      }));
      const expected = [
        ["changed", "a", "1"],
        ...(operation === "clear" ? [["deleted", "a", undefined]] : []),
        ["changed", "sentinel", "1"],
      ];
      expect(events.window).toEqual(expected);
      expect(events.worker).toEqual(expected);
      return events;
    });
  });
}

declare global {
  interface Window {
    observedCookieChanges: (string | undefined)[][];
  }
}

test("clears both private host identities on all paths and preserves other session hosts", async ({ fixture }) => {
  const { app, page, storageOrigin } = fixture;
  const others = ["https://other.test", "https://child.app.desktop"];
  await app.evaluate(async ({ session }, origins) => {
    for (const url of origins)
      await session.defaultSession.cookies.set({ url, name: "sid", value: "other", path: "/" });
  }, others);
  await fixture.set(
    ["sid=host; Path=/", "sid=domain; Domain=127.0.0.1; Path=/; HttpOnly", "nested=1"],
    "/long;directory/page",
  );
  const records = () =>
    app.evaluate(
      async ({ session }, domain) =>
        (await session.defaultSession.cookies.get({ domain }))
          .map((c) => [c.domain, c.path])
          .toSorted((a, b) => a.join("\n").localeCompare(b.join("\n"))),
      new URL(storageOrigin).hostname,
    );
  expect(await records()).toEqual([
    [".app.desktop", "/"],
    ["app.desktop", "/"],
    ["app.desktop", "/long;directory"],
  ]);
  const reply = await fixture.replyPath({ cookies: [], clearSiteData: '"cookies"' });
  await page.evaluate((url) => fetch(url, { credentials: "omit" }).then((r) => r.text()), reply);
  expect(await records()).toHaveLength(3);
  await requestCookie(page, reply);
  expect(await records()).toEqual([]);
  expect(
    await app.evaluate(async ({ session }) =>
      (await session.defaultSession.cookies.get({})).map((c) => c.domain ?? "").toSorted(),
    ),
  ).toEqual(["child.app.desktop", "other.test"]);
});
