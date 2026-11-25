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
          before = err instanceof Error ? { name: err.name, message: err.message } : String(err);
        }
        try {
          document.cookie = name + "=yes";
          after = document.cookie;
        } catch (err) {
          writeError = err instanceof Error ? { name: err.name, message: err.message } : String(err);
        }
        let structured;
        try {
          structured = (await cookieStore.get("scope"))?.value;
        } catch (err) {
          structured = err instanceof Error ? { name: err.name, message: err.message } : String(err);
        }
        return { before, after, writeError, structured };
      }, cookieName);
      if (i === 2) {
        expect(result).toMatchObject({ before: { name: "SecurityError" }, writeError: { name: "SecurityError" } });
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

test("DC-20 | paired CSP sandbox policies govern writes and subresource cookies", async ({ fixture }) => {
  await compareNative(fixture, "/", async (site) => {
    const results = [];
    await fixture.set(["private=only-parent; Path=/"]);
    for (const sameOrigin of [false, true]) {
      const path = "/__e2e/sandbox" + (sameOrigin ? "?sameOrigin" : "");
      await fixture.page.evaluate((src) => {
        const frame = document.createElement("iframe");
        frame.name = "opaque-cookie-probe";
        frame.src = src;
        document.body.replaceChildren(frame);
      }, path);
      const target = fixture.page.frameLocator("iframe").locator("title");
      const reply = await fixture.replyPath(["subresource=accepted; Path=/"], "/echo");
      const result = await target.evaluate(async (_title, url) => {
        // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into the child frame.
        async function observe(run: () => unknown) {
          try {
            return await run();
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { name: error.name, message: error.message };
          }
        }
        const read = await observe(() => document.cookie);
        const write = await observe(() => {
          document.cookie = "child=written; Path=/";
          return document.cookie;
        });
        const set = await observe(() => cookieStore.set("structured", "written"));
        const get = await observe(() => cookieStore.get("private"));
        const response = await fetch(url);
        return { opaque: self.origin === "null", read, write, set, get, wire: await response.text() };
      }, fixture.origins[site] + reply);
      expect(result.opaque).toBe(!sameOrigin);
      if (sameOrigin) {
        expect(result.write).toContain("child=written");
        expect(result.get).toMatchObject({ value: "only-parent" });
        expect(result.wire).toContain("private=only-parent");
      } else {
        expect(result.read).toMatchObject({ name: "SecurityError" });
        expect(result.write).toMatchObject({ name: "SecurityError" });
        expect(result.wire).toBe("");
        if (site === "jar") await expectOpaqueDenial(fixture, fixture.origins.jar + path);
      }
      const parent = await requestCookie(fixture.page);
      expect(parent.includes("subresource=accepted")).toBe(sameOrigin);
      results.push({ ...result, parent });
    }
    return results;
  });
});

test("DC-21/25 | about:blank and blob documents preserve their cookie and fetch boundaries", async ({ fixture }) => {
  await compareNative(fixture, "/", async (site) => {
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
        const store = [];
        for (const run of [
          () => cookieStore.getAll(),
          () => cookieStore.set("blobApi", "value"),
          () => cookieStore.get("blobApi"),
        ]) {
          try {
            store.push({ value: await run() });
          } catch (err) {
            if (!(err instanceof Error)) throw err;
            store.push({ name: err.name, message: err.message });
          }
        }
        return {
          text: document.cookie,
          error,
          store,
          wire: await (await fetch(url)).text(),
          omit: await (await fetch(url, { credentials: "omit" })).text(),
        };
      }, echoUrl);
    expect(blob).toMatchObject({ text: "", error: "TypeError", omit: "", wire: "root=visible" });
    return blob;
  });
});

test("DC-22/23 | foreign frames keep their native cookie and fetch APIs", async ({ fixture }) => {
  const other = await fixture.app.evaluate(() => globalThis.cookieFixture.otherOrigin);
  const baselines = new Map<string, unknown>();
  for (const site of ["localhost", "https", "jar"] as const) {
    await fixture.visit(site);
    await fixture.set(["parent=classified; Path=/"]);
    for (const frameUrl of [
      fixture.origins.localhost + "/",
      fixture.origins.https + "/",
      other + "/",
      "data:text/html,<title>data</title>",
    ]) {
      if (frameUrl === fixture.origins[site] + "/") continue;
      await fixture.page.evaluate((src) => {
        const frame = document.createElement("iframe");
        frame.src = src;
        document.body.replaceChildren(frame);
      }, frameUrl);
      const native = await fixture.page
        .frameLocator("iframe")
        .locator("title")
        .evaluate(async () => {
          // oxlint-disable-next-line typescript/unbound-method -- Inspect the getter function without invoking it.
          const getter = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!.get!;
          const storeGetter = Object.getOwnPropertyDescriptor(window, "cookieStore");
          // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into the child frame.
          const read = async (run: () => unknown) => {
            try {
              return { value: await run() };
            } catch (err) {
              if (!(err instanceof Error)) throw err;
              return { error: err.name, message: err.message };
            }
          };
          return {
            text: await read(() => document.cookie),
            rows: await read(() => window.cookieStore?.getAll()),
            protocol: location.protocol,
            store: !storeGetter || storeGetter.get?.toString().includes("[native code]"),
            cookie: Function.prototype.toString.call(getter).includes("[native code]"),
            fetch: Function.prototype.toString.call(fetch).includes("[native code]"),
          };
        });
      expect(native).toMatchObject({ protocol: new URL(frameUrl).protocol, store: true, cookie: true, fetch: true });
      if ("error" in native.text) expect(native.text.error).toBe("SecurityError");
      else expect(native.text.value).toBe("");
      if ("error" in native.rows) expect(native.rows.error).toBe("SecurityError");
      else if (native.rows.value !== undefined) expect(native.rows.value).toEqual([]);
      if (baselines.has(frameUrl)) expect(native).toEqual(baselines.get(frameUrl));
      else baselines.set(frameUrl, native);
    }
    expect(await requestCookie(fixture.page)).toBe("parent=classified");
  }
});

test("DC-18 | nested srcdoc inherits the document cookie URL for mutations, events and fetch", async ({ fixture }) => {
  await compareNative(
    fixture,
    "/account/page",
    async (site) => {
      const { page } = fixture;
      await fixture.set(["scope=visible; Path=/account"]);
      await page.evaluate(() => {
        history.pushState({}, "", "/other/page");
        const frame = document.createElement("iframe");
        frame.srcdoc = '<iframe srcdoc="<body>nested</body>"></iframe>';
        document.body.append(frame);
      });
      const target = page.frameLocator("iframe").frameLocator("iframe").getByText("nested");
      const result = await target.evaluate(async (_el, origin) => {
        const events: Pick<CookieChangeEvent, "changed" | "deleted" | "isTrusted">[] = [];
        let finish!: () => void;
        const fence = new Promise<void>((resolve) => {
          finish = resolve;
        });
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Exercise onchange inside the nested document.
        cookieStore.onchange = (e) => {
          events.push({ changed: e.changed, deleted: e.deleted, isTrusted: e.isTrusted });
          if (e.changed.some((c) => c.name === "nestedFence")) finish();
        };
        const initial = await cookieStore.get("scope");
        const urls = [];
        for (const url of [origin + "/account/page", origin + "/other/page", "about:srcdoc"]) {
          try {
            urls.push(await cookieStore.get({ name: "scope", url }));
          } catch (err) {
            if (!(err instanceof Error)) throw err;
            urls.push({ name: err.name, message: err.message });
          }
        }
        await cookieStore.set("nestedApi", "visible");
        const wire = await (await fetch(origin + "/account/echo")).text();
        const omit = await (await fetch(origin + "/account/echo", { credentials: "omit" })).text();
        await cookieStore.delete("nestedApi");
        await cookieStore.set("nestedFence", "end");
        await fence;
        return { initial, urls, wire, omit, events };
      }, fixture.origins[site]);
      expect(result.initial).toMatchObject({ value: "visible" });
      expect(result.wire).toContain("nestedApi=visible");
      expect(result.omit).toBe("");
      expect(result.events.flatMap((e) => e.deleted.map((c) => c.name))).toEqual(["nestedApi"]);
      for (const event of result.events) expect(event.isTrusted).toBe(site !== "jar");
      return result;
    },
    (native) => ({ ...native, events: native.events.map((e) => ({ ...e, isTrusted: false })) }),
  );
});
