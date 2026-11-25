import { compareNative, expect, requestCookie, test } from "./fixture.ts";

test("CS-01..08, CS-10 | native cookie dictionaries, order, URL validation and mutations", async ({ fixture }) => {
  const expiresAt = Math.floor(Date.now() / 1000) * 1000 + 3600_000;
  await compareNative(fixture, "/account/page", async () => {
    await fixture.set(["sid=root; Path=/", "sid=scoped; Path=/account", "hidden=h; HttpOnly; Path=/"]);
    const serverReply = await fixture.replyPath(["fromServer=read; Path=/"]);
    const result = await fixture.page.evaluate(
      async ({ expiry, reply }) => {
        const options = await cookieStore.get({ name: "sid" });
        const first = await cookieStore.get("sid");
        const all = await cookieStore.getAll();
        const named = await cookieStore.getAll("sid");
        const missing = await cookieStore.get("absent");
        await cookieStore.set("fromApi", "read");
        const defaultItem = await cookieStore.get("fromApi");
        await cookieStore.set({
          name: "scoped",
          value: "path",
          path: "/old/../account",
          expires: expiry,
          sameSite: "lax",
        });
        const scoped = await cookieStore.get("scoped");
        document.cookie = "fromDocument=read; Path=/";
        const fromDocument = await cookieStore.get("fromDocument");
        const response = await fetch(reply);
        const fromServer = await cookieStore.get("fromServer");
        const wire = await response.text();
        const text = document.cookie;
        const original = location.href;
        history.pushState({}, "", "/another/page");
        const urls = [
          original,
          original + "#frag",
          location.href,
          "#frag",
          "../account/page",
          "http://[",
          "",
          "page",
          "page/",
          "?other",
          "page?",
        ];
        const matches = [];
        for (const url of urls) {
          try {
            matches.push({ input: url.replace(location.origin, "ORIGIN"), cookies: await cookieStore.getAll({ url }) });
          } catch (err) {
            if (!(err instanceof Error)) throw err;
            matches.push({
              input: url.replace(location.origin, "ORIGIN"),
              typeError: err instanceof TypeError,
              name: err.name,
              message: err.message,
            });
          }
        }
        await cookieStore.delete("fromApi");
        await cookieStore.delete({ name: "scoped", path: "/account" });
        await cookieStore.delete("missing");
        return {
          options,
          first,
          all,
          named,
          missing,
          defaultItem,
          scoped,
          fromDocument,
          fromServer,
          wire,
          text,
          matches,
          last: await cookieStore.getAll(),
        };
      },
      { expiry: expiresAt, reply: serverReply },
    );
    expect(result.options).toEqual(result.first);
    expect(result.named.map((c) => c.value)).toEqual(["scoped", "root"]);
    expect(result.missing).toBeNull();
    expect(result.all.map((c) => c.name)).not.toContain("hidden");
    expect(result.defaultItem).toEqual({
      name: "fromApi",
      value: "read",
      path: "/",
      secure: true,
      domain: null,
      sameSite: "strict",
      partitioned: false,
      expires: null,
    });
    expect(result.scoped).toMatchObject({ path: "/account/", expires: expiresAt, sameSite: "lax" });
    expect(result.wire).toContain("fromApi=read");
    expect(result.text).toContain("fromApi=read");
    expect(result.fromDocument?.value).toBe("read");
    expect(result.fromServer?.value).toBe("read");
    expect(result.matches[2]).toMatchObject({ typeError: true, name: "TypeError" });
    expect(result.last.some((c) => c.name === "fromApi" || c.name === "scoped")).toBe(false);
    return result;
  });
});

for (const path of ["/account/page?q=1", "/account/page?q=1#initial", "/account/page/?q=1"]) {
  test("CS-03 | explicit URL matching on initial navigation to " + path, async ({ fixture }) => {
    await compareNative(fixture, path, async () =>
      fixture.page.evaluate(async () => {
        document.cookie = "probe=visible; Path=/";
        const original = location.href;
        history.pushState({}, "", "/new/page?q=2");
        const outcomes: Record<string, unknown> = {};
        for (const input of [
          "",
          "#frag",
          "?q=1",
          "page?q=1",
          "./?q=1",
          "../page?q=1",
          "/account/page?q=2",
          "/account/page/?q=1",
          "absolute-original",
          "absolute-current",
        ]) {
          const url = input === "absolute-original" ? original : input === "absolute-current" ? location.href : input;
          try {
            outcomes[input] = await cookieStore.get({ name: "probe", url });
          } catch (err) {
            if (!(err instanceof TypeError)) throw err;
            outcomes[input] = { name: err.name, message: err.message };
          }
        }
        return outcomes;
      }),
    );
  });
}

test("CS-07/09 | invalid inputs reject with Chromium's exact TypeError and preserve the jar", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    await fixture.set(["a=untouched; Path=/", "shield=private; Secure; HttpOnly; Path=/"]);
    const results = await fixture.page.evaluate(async () => {
      const operations = [
        () => cookieStore.set("a=b", "v"),
        () => cookieStore.set("a", "v; Max-Age=0"),
        () => cookieStore.set("", ""),
        () => cookieStore.set("a", "a\tb"),
        () => cookieStore.set("a", "x".repeat(4096)),
        () => cookieStore.set({ name: "__Host-x", value: "v", path: "/x" }),
        () => cookieStore.set({ name: "a", value: "v", domain: "elsewhere.test" }),
        () => cookieStore.set({ name: "a", value: "v", domain: ".example.test" }),
        () => cookieStore.delete({ name: "a", domain: ".example.test" }),
        () => cookieStore.set("shield", "changed"),
        () => cookieStore.delete("shield"),
      ];
      const errors = [];
      for (const attempt of operations) {
        const pending = attempt();
        try {
          await pending;
          errors.push(null);
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          errors.push({ typeError: err instanceof TypeError, name: err.name, message: err.message });
        }
      }
      return errors;
    });
    for (const err of results)
      expect(err).toMatchObject({ typeError: true, name: "TypeError", message: expect.any(String) });
    expect(await requestCookie(fixture.page)).toBe("a=untouched; shield=private");
    return results;
  });
});

type ObservedEvent = { changed: CookieListItem[]; deleted: CookieListItem[]; native: boolean; type: string };
declare global {
  interface Window {
    cookieEvents: { listener: ObservedEvent[]; property: ObservedEvent[] };
  }
}

test("CS-11..13, DC-13 | events from all writers, path and HttpOnly filtering, cross-window visibility", async ({
  fixture,
}) => {
  const expiry = Math.floor(Date.now() / 1000) * 1000 + 3600_000;
  await compareNative(fixture, "/", async (site) => {
    const { page } = fixture;
    const peer = await fixture.peer(site, "/?peer");
    try {
      await page.evaluate(() => {
        window.cookieEvents = { listener: [], property: [] };
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into the renderer.
        const shape = (e: CookieChangeEvent) => ({
          changed: e.changed.map((c) => ({ ...c })),
          deleted: e.deleted.map((c) => ({ ...c })),
          native: e instanceof CookieChangeEvent,
          type: e.type,
        });
        cookieStore.addEventListener("change", (e) => window.cookieEvents.listener.push(shape(e)));
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Exercise the event handler property itself.
        cookieStore.onchange = (e) => window.cookieEvents.property.push(shape(e));
      });
      // Each visible change is acknowledged before starting the next mutation. The final sentinel
      // fences off invisible and identical writes without sleeping or assuming an IPC latency.
      const waitFor = async (cookieName: string, cookieValue?: string) =>
        page.waitForFunction(
          ({ name, value }) =>
            window.cookieEvents.property.some((e) =>
              (value === undefined ? e.deleted : e.changed).some((c) => c.name === name && c.value === value),
            ),
          { name: cookieName, value: cookieValue },
        );
      await page.evaluate(() => {
        document.cookie = "doc=one; Path=/";
      });
      expect(await peer.evaluate(() => document.cookie)).toBe("doc=one");
      await waitFor("doc", "one");
      await page.evaluate(() => cookieStore.set("api", "one"));
      await waitFor("api", "one");
      await page.evaluate(() => cookieStore.set("api", "one"));
      await page.evaluate((expires) => cookieStore.set({ name: "api", value: "one", expires }), expiry);
      await page.waitForFunction(
        (expires) =>
          window.cookieEvents.property.some((e) => e.changed.some((c) => "expires" in c && c.expires === expires)),
        expiry,
      );
      await page.evaluate(() => cookieStore.set("api", "two"));
      await waitFor("api", "two");
      await fixture.set(["server=three; Path=/"]);
      await waitFor("server", "three");
      await peer.evaluate(() => {
        document.cookie = "peer=four; Path=/";
      });
      await waitFor("peer", "four");
      await page.evaluate(() => cookieStore.delete("api"));
      await waitFor("api");
      await fixture.set(["hidden=1; HttpOnly; Path=/", "scoped=1; Path=/other"]);
      await page.evaluate(() => cookieStore.delete("absent"));
      await page.evaluate(() => cookieStore.set("fence", "end"));
      await waitFor("fence", "end");
      const { listener, property } = await page.evaluate(() => window.cookieEvents);
      expect(property).toEqual(listener);
      expect(listener.every((e) => e.native && e.type === "change")).toBe(true);
      expect(listener.flatMap((e) => e.changed.map((c) => [c.name, c.value]))).toEqual([
        ["doc", "one"],
        ["api", "one"],
        ["api", "one"],
        ["api", "two"],
        ["server", "three"],
        ["peer", "four"],
        ["fence", "end"],
      ]);
      expect(listener.flatMap((e) => e.deleted.map((c) => c.name))).toEqual(["api"]);
      if (site === "jar") {
        const id = await fixture.app.evaluate(
          ({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().find(
              (w) => w.webContents.getURL() === globalThis.cookieFixture.origins.jar + "/",
            )?.webContents.id,
        );
        const pushed = await fixture.app.evaluate(() => globalThis.cookieFixture.pushes);
        expect([...new Set(pushed)]).toEqual([id]);
      }
      return property;
    } finally {
      await peer.close();
    }
  });
});
