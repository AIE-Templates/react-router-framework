import { compareNative, expect, requestCookie, test, type Fixture } from "./fixture.ts";

async function expectOpaqueDenial({ app }: Fixture, url: string) {
  const targetFrame = await app.evaluate((_electron, target) => globalThis.cookieFixture.probeOpaque(target), url);
  expect(targetFrame).toEqual({ origin: "null", preloadStarted: true });
  await expect
    .poll(() =>
      app.evaluate(() => ({
        steps: globalThis.cookieFixture.opaqueSteps,
        preloadErrors: globalThis.cookieFixture.preloadErrors,
      })),
    )
    .toEqual({
      preloadErrors: [],
      steps: [
        { stage: "start" },
        { stage: "sync", text: "" },
        {
          stage: "invoke",
          result: {
            ok: false,
            error: { name: "SecurityError", message: "Access to the CookieStore API is denied in this context." },
          },
        },
      ],
    });
}

test("DC-18/20/21 | inherited srcdoc URL and sandboxed read/write behavior match native", async ({ fixture }) => {
  await compareNative(fixture, "/account/page", async (site) => {
    const { page } = fixture;
    await fixture.set(["scope=visible; Path=/account", "root=visible; Path=/"]);
    await page.evaluate(() => {
      history.pushState({}, "", "/other/page");
      for (const sandbox of [null, "allow-scripts allow-same-origin", "allow-scripts"]) {
        const frame = document.createElement("iframe");
        if (sandbox === "allow-scripts") frame.name = "opaque-cookie-probe";
        if (sandbox !== null) frame.setAttribute("sandbox", sandbox);
        frame.srcdoc = "<body>child</body>";
        document.body.append(frame);
      }
    });
    const results = [];
    for (const [i, cookieName] of ["child", "sandboxChild", "opaque"].entries()) {
      const frame = page.frameLocator("iframe").nth(i).locator("body");
      const result = await frame.evaluate(async (_body, name) => {
        let before, after, writeError;
        try {
          before = document.cookie;
        } catch (err) {
          before = err instanceof Error ? err.name : String(err);
        }
        try {
          document.cookie = name + "=yes";
          after = document.cookie;
        } catch (err) {
          writeError = err instanceof Error ? err.name : String(err);
        }
        let structured;
        try {
          structured = (await cookieStore.get("scope"))?.value;
        } catch (err) {
          structured = err instanceof Error ? err.name : String(err);
        }
        return { before, after, writeError, structured };
      }, cookieName);
      if (i === 2) {
        expect(result).toMatchObject({ before: "SecurityError", writeError: "SecurityError" });
      } else {
        expect(result.before).toContain("scope=visible");
        expect(result.after).toContain(cookieName + "=yes");
        expect(result.structured).toBe("visible");
      }
      results.push(result);
    }
    const scoped = await requestCookie(page, "/account/echo");
    expect(scoped).toContain("sandboxChild=yes");
    expect(await requestCookie(page, "/other/echo")).toBe("root=visible");
    if (site === "jar") {
      await expectOpaqueDenial(fixture, "about:srcdoc");
    }
    return results;
  });
});

test("DC-20 | CSP sandbox gives the response document an opaque origin", async ({ fixture }) => {
  await fixture.set(["private=only-parent; Path=/"]);
  await fixture.page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.name = "opaque-cookie-probe";
    frame.src = "/__e2e/sandbox";
    document.body.append(frame);
  });
  const target = fixture.page.frameLocator("iframe").locator("title");
  expect(
    await target.evaluate(() => {
      try {
        return document.cookie;
      } catch (e) {
        return [self.origin, e instanceof Error ? e.name : String(e)];
      }
    }),
  ).toEqual(["null", "SecurityError"]);
  await expectOpaqueDenial(fixture, fixture.origins.jar + "/__e2e/sandbox");
});

test("DC-21/25 | about:blank and blob documents preserve their cookie and fetch boundaries", async ({ fixture }) => {
  for (const site of ["https", "localhost", "jar"] as const) {
    await fixture.visit(site);
    await fixture.set(["root=visible; Path=/"]);
    const { page } = fixture;
    await page.evaluate(() => {
      for (const [id, src] of [
        ["blank", "about:blank"],
        ["blob", URL.createObjectURL(new Blob(["<body>blob</body>"], { type: "text/html" }))],
      ]) {
        const frame = document.createElement("iframe");
        frame.id = id;
        frame.src = src;
        document.body.append(frame);
      }
    });
    const echoUrl = fixture.origins[site] + "/echo";
    const blank = await page
      .frameLocator("#blank")
      .locator("html")
      .evaluate(
        async (_el, url) => ({ text: document.cookie, omit: await (await fetch(url, { credentials: "omit" })).text() }),
        echoUrl,
      );
    expect(blank).toEqual(site === "jar" ? { text: "", omit: "root=visible" } : { text: "root=visible", omit: "" });
    const blob = await page
      .frameLocator("#blob")
      .getByText("blob")
      .evaluate(async (_body, url) => {
        document.cookie = "blob=ignored";
        const pending = fetch("relative");
        const error = await pending.then(
          () => null,
          (err: unknown) => (err instanceof Error ? err.name : String(err)),
        );
        return { text: document.cookie, error, omit: await (await fetch(url, { credentials: "omit" })).text() };
      }, echoUrl);
    expect(blob).toEqual({ text: "", error: "TypeError", omit: "" });
  }
});

test("DC-22/23 | foreign frames keep their native cookie and fetch APIs", async ({ fixture }) => {
  await fixture.set(["jar=classified; Path=/"]);
  const other = await fixture.app.evaluate(() => globalThis.cookieFixture.otherOrigin);
  for (const frameUrl of [
    fixture.origins.localhost + "/",
    fixture.origins.https + "/",
    other + "/",
    "data:text/html,<title>data</title>",
  ]) {
    await fixture.page.evaluate((src) => {
      const frame = document.createElement("iframe");
      frame.src = src;
      document.body.replaceChildren(frame);
    }, frameUrl);
    const native = await fixture.page
      .frameLocator("iframe")
      .locator("title")
      .evaluate(() => {
        // oxlint-disable-next-line typescript/unbound-method -- Inspect the getter function without invoking it.
        const getter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.get!;
        const storeGetter = Object.getOwnPropertyDescriptor(window, "cookieStore");
        return {
          protocol: location.protocol,
          store: !storeGetter || storeGetter.get?.toString().includes("[native code]"),
          cookie: Function.prototype.toString.call(getter).includes("[native code]"),
          fetch: Function.prototype.toString.call(fetch).includes("[native code]"),
        };
      });
    expect(native).toEqual({ protocol: new URL(frameUrl).protocol, store: true, cookie: true, fetch: true });
  }
});
