import type { Page } from "@playwright/test";

import { compareNative, expect, requestCookie, test } from "./fixture.ts";

test("CS-01..08, CS-10 | native cookie dictionaries, order, URL validation and mutations", async ({ fixture }) => {
  const expiresAt = new Date().setMilliseconds(375) + 3600_000;
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

type ObservedEvent = {
  changed: CookieListItem[];
  deleted: CookieListItem[];
  native: boolean;
  type: string;
  isTrusted: boolean;
};
declare global {
  // Electron exposes the complete CookieListItem dictionary; lib.dom currently types name/value only.
  interface CookieListItem {
    expires?: number | null;
    partitioned?: boolean;
    domain?: string | null;
  }
  interface Window {
    cookieEvents: { listener: ObservedEvent[]; property: ObservedEvent[] };
  }
}

test("CS-11..13, DC-13 | events from all writers, path and HttpOnly filtering, cross-window visibility", async ({
  fixture,
}) => {
  const expiry = new Date().setMilliseconds(375) + 3600_000;
  await compareNative(
    fixture,
    "/",
    async (site) => {
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
            isTrusted: e.isTrusted,
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
        await page.waitForFunction(() =>
          window.cookieEvents.property.some((e) => e.changed.some((c) => c.name === "api" && c.expires != null)),
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
        for (const event of property) expect(event.isTrusted).toBe(site !== "jar");
        return property;
      } finally {
        await peer.close();
      }
    },
    (native) => native.map((event) => ({ ...event, isTrusted: false })),
  );
});

test("CS-07 | set, delete and get report native validation errors for each overload", async ({ fixture }) => {
  await compareNative(fixture, "/account/page", async (site) => {
    const errors = await fixture.page.evaluate(async () => {
      const cases: [keyof Pick<CookieStore, "get" | "set" | "delete">, unknown[]][] = [
        ["get", []],
        ["get", [{}]],
        ["get", [{ url: "http://[" }]],
        ["get", [{ url: "/other" }]],
        ["set", []],
        ["set", ["single"]],
        ["set", [null]],
        ["set", [undefined]],
        ["set", [{ value: "v" }]],
        ["set", [{ name: "a" }]],
        ["delete", []],
        ["delete", [{}]],
        ["set", ["", "a=b"]],
        ["set", ["", "__Secure-x"]],
        ["set", ["", "__hOsT-x"]],
        ["set", ["", "__Http-x"]],
        ["set", [{ name: "a", value: "b", expires: Infinity }]],
        ["set", [{ name: "a", value: "b", expires: 123, maxAge: 2 }]],
        ["set", [{ name: "a", value: "b", sameSite: "INVALID" }]],
        ["set", [{ name: "a", value: "b", sameSite: "bad\ud800" }]],
      ];
      for (const options of [
        { name: "__hTtP-one" },
        { name: "__Host-Http-one" },
        { name: "__Host-one", domain: location.hostname },
        { name: "__Host-one", path: "" },
        { name: "__Host-one", path: "/nested" },
        { name: "a", path: "relative" },
        { name: "a", path: "/" + "x".repeat(1023) },
        { name: "a", path: "/x;y" },
        { name: "a", domain: ".bad" },
        { name: "a", domain: "foreign.test" },
      ]) {
        cases.push(["set", [{ ...options, value: "v" }]], ["delete", [options]]);
      }
      const rows = [];
      for (const [method, args] of cases) {
        const input = JSON.stringify(args, (_key, value: unknown) =>
          value === location.hostname
            ? "HOST"
            : value === Infinity
              ? "Infinity"
              : value === undefined
                ? "undefined"
                : value,
        );
        try {
          await Reflect.apply(cookieStore[method], cookieStore, args);
          rows.push({ method, input, error: null });
        } catch (e) {
          if (!(e instanceof Error)) throw e;
          rows.push({
            method,
            input,
            error: {
              typeError: e instanceof TypeError,
              name: e.name,
              message: e.message,
              // Keep the UTF-16 evidence intact even if a transport replaces lone surrogates.
              ...(input.includes("\\ud800") && { hasOriginalSurrogate: e.message.includes("\ud800") }),
            },
          });
        }
      }
      return rows;
    });
    const records = await fixture.stored(site);
    for (const row of errors)
      expect
        .soft(row.error, site + " " + row.method + " " + row.input)
        .toMatchObject({ typeError: true, name: "TypeError" });
    expect
      .soft(errors.find((row) => row.input.includes("\\ud800"))?.error)
      .toMatchObject({ hasOriginalSurrogate: true });
    expect.soft(records).toEqual([]);
    return { errors, records };
  });
});

test("CS-02/06 | paths, empty names, whitespace filters, SameSite and relative lifetimes", async ({ fixture }) => {
  await compareNative(fixture, "/account/page", async (site) => {
    const result = await fixture.page.evaluate(async () => {
      await cookieStore.set({ name: "name", value: "v", sameSite: "none", path: "" });
      await cookieStore.set("", "bare");
      const rows = await cookieStore.getAll();
      const whitespace = [await cookieStore.get(" name "), await cookieStore.getAll({ name: "\tname\t" })];
      const nameless = await cookieStore.get("");
      await cookieStore.delete("");
      await cookieStore.set("past", "seed");
      await cookieStore.set({ name: "past", value: "gone", expires: 1000 });
      const before = Date.now();
      const duration = { name: "lifetime", value: "v", maxAge: 60 };
      await cookieStore.set(duration);
      const lifetime = await cookieStore.get("lifetime");
      const after = Date.now();
      const zero = { ...duration, maxAge: 0 };
      await cookieStore.set(zero);
      const paths = [
        "/a?b",
        "/a#b",
        "/a|b",
        "/a\\b",
        "/a\tb",
        "/目录",
        "//double",
        "/old/../new",
        "/%2f",
        "/" + "p".repeat(1022),
      ];
      const outcomes = [];
      for (const [i, path] of paths.entries()) {
        try {
          await cookieStore.set({ name: "path" + i, value: "ok", path });
          outcomes.push(null);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          outcomes.push([error.name, error.message]);
        }
      }
      return {
        rows,
        whitespace,
        nameless,
        deleted: await cookieStore.get(""),
        past: await cookieStore.get("past"),
        before,
        after,
        lifetime,
        expired: await cookieStore.get("lifetime"),
        outcomes,
      };
    });
    expect(result.nameless).toMatchObject({ name: "", value: "bare" });
    expect(result.deleted).toBeNull();
    expect(result.past).toBeNull();
    expect(result.expired).toBeNull();
    const { before, after, lifetime, ...rest } = result;
    expect(lifetime?.expires).toBeGreaterThanOrEqual(before + 60_000 - 1);
    expect(lifetime?.expires).toBeLessThanOrEqual(after + 60_000 + 1);
    return { ...rest, lifetime: { ...lifetime, expires: 60 }, records: await fixture.stored(site) };
  });
});

test("CS-15 | partition collisions and unqualified delete through cookieStore", async ({ fixture }) => {
  for (const site of ["localhost", "https", "jar"] as const) {
    await fixture.visit(site);
    const result = await fixture.page.evaluate(async () => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized into the renderer.
      const read = async () => (await cookieStore.getAll("id")).map((c) => [c.value, c.partitioned]);
      await cookieStore.set({ name: "id", value: "partition", partitioned: true });
      await cookieStore.delete("id");
      const unqualified = await read();
      await cookieStore.set({ name: "id", value: "partition", partitioned: true });
      await cookieStore.set({ name: "id", value: "plain" });
      const both = await read();
      await cookieStore.delete("id");
      const after = await read();
      await cookieStore.delete({ name: "id", partitioned: true });
      return { unqualified, both, after, end: await read() };
    });
    expect(result.unqualified).toEqual(site === "jar" ? [] : [["partition", true]]);
    expect(result.both).toEqual(
      site === "jar"
        ? [["plain", false]]
        : [
            ["partition", true],
            ["plain", false],
          ],
    );
    expect(result.after).toEqual(site === "jar" ? [] : [["partition", true]]);
    expect(result.end).toEqual([]);
  }
});

type Change = Pick<CookieChangeEvent, "changed" | "deleted" | "isTrusted">;

declare global {
  interface Window {
    changes: Change[];
  }
}

async function recordChanges(page: Page) {
  await page.evaluate(() => {
    window.changes = [];
    cookieStore.addEventListener("change", ({ changed, deleted, isTrusted }) => {
      window.changes.push({ changed, deleted, isTrusted });
    });
  });
}

async function finishChanges(page: Page, isJar: boolean) {
  await page.evaluate(() => cookieStore.set("fence", "done"));
  await page.waitForFunction(() => window.changes.some((event) => event.changed.some((item) => item.name === "fence")));
  const changes = await page.evaluate(() => window.changes);
  for (const event of changes) expect(event.isTrusted).toBe(!isJar);
  return changes;
}

function syntheticChanges(events: Change[]) {
  return events.map((event) => ({ ...event, isTrusted: false }));
}

test("CS-11/12 | server and script deletions, path boundary and same-task event order", async ({ fixture }) => {
  const { page } = fixture;
  await compareNative(
    fixture,
    "/account/page",
    async (site) => {
      await recordChanges(page);
      await fixture.set(["server=1; Path=/account", "sibling=hidden; Path=/account2", "batch=2; Path=/account"]);
      await page.evaluate(() => {
        document.cookie = "burstA=1";
        document.cookie = "burstB=2";
        document.cookie = "burstA=3";
        document.cookie = "burstB=; Max-Age=0";
      });
      await fixture.set(["server=; Path=/account; Max-Age=0", "tail=3; Path=/account"]);
      const events = await finishChanges(page, site === "jar");
      expect(events.flatMap((e) => e.changed.map((c) => c.name))).toEqual([
        "server",
        "batch",
        "burstA",
        "burstB",
        "burstA",
        "tail",
        "fence",
      ]);
      expect(events.flatMap((e) => e.deleted.map((c) => c.name))).toEqual(["burstB", "server"]);
      return events;
    },
    syntheticChanges,
  );
});

test("CS-11/12 | domain-cookie change dictionaries preserve domain and deletion identity", async ({ fixture }) => {
  const { page } = fixture;
  const native = [];
  for (const site of ["localhost", "https", "jar"] as const) {
    await fixture.visit(site, "/account/page");
    await recordChanges(page);
    await page.evaluate(async () => {
      const options = { name: "domain", domain: location.hostname };
      await cookieStore.set({ ...options, value: "visible" });
      await cookieStore.delete(options);
    });
    const events = await finishChanges(page, site === "jar");
    const host = new URL(fixture.origins[site]).hostname;
    const canonical = (item: CookieListItem) => ({ ...item, domain: item.domain === host ? "HOST" : item.domain });
    const observed = events.map((e) => ({
      ...e,
      changed: e.changed.map(canonical),
      deleted: e.deleted.map(canonical),
    }));
    expect(observed.flatMap((e) => e.changed.map((c) => c.name))).toEqual(["domain", "fence"]);
    expect(observed.flatMap((e) => e.deleted.map((c) => c.name))).toEqual(["domain"]);
    for (const row of observed.flatMap((e) => [...e.changed, ...e.deleted]).filter((c) => c.name === "domain"))
      expect(row.domain).toBe(site === "localhost" ? null : "HOST");
    if (site === "https") native.push(...observed);
    if (site === "jar") expect(observed).toEqual(syntheticChanges(native));
  }
});

test("DC-01, CS-11 | natural Max-Age expiry removes the wire cookie and reports its deletion", async ({ fixture }) => {
  const { page } = fixture;
  await compareNative(
    fixture,
    "/",
    async (site) => {
      await recordChanges(page);
      // The jar computes Max-Age with the main process clock, which can differ from the renderer clock.
      const mainBefore = site === "jar" ? await fixture.app.evaluate(() => Date.now()) : undefined;
      const timing = await page.evaluate(() => {
        const before = Date.now();
        document.cookie = "ephemeral=yes; Max-Age=1";
        return { before, text: document.cookie, after: Date.now() };
      });
      const after = site === "jar" ? await fixture.app.evaluate(() => Date.now()) : timing.after;
      const before = mainBefore ?? timing.before;
      expect(timing.text).toBe("ephemeral=yes");
      await expect.poll(() => requestCookie(page)).toBe("");
      expect(await page.evaluate(() => document.cookie)).toBe("");
      const events = await finishChanges(page, site === "jar");
      expect(events.flatMap((e) => e.changed.map((c) => c.name))).toEqual(["ephemeral", "fence"]);
      const expires = events.flatMap((e) => e.changed).find((c) => c.name === "ephemeral")?.expires;
      expect(expires).toBeGreaterThanOrEqual(before + 1000 - 1);
      expect(expires).toBeLessThanOrEqual(after + 1000 + 1);
      // Relative expiration timestamps depend on when each site's write started.
      return events.map((e) => ({
        ...e,
        changed: e.changed.map((c) =>
          c.name === "ephemeral" ? { ...c, expires: typeof c.expires === "number" ? 1000 : c.expires } : c,
        ),
      }));
    },
    syntheticChanges,
  );
});

test("CS-11 | crossing the 180-cookie domain quota evicts the native identities and emits their deletions", async ({
  fixture,
}) => {
  const { page } = fixture;
  await compareNative(
    fixture,
    "/",
    async (site) => {
      await recordChanges(page);
      await page.evaluate(() => {
        for (let i = 0; i <= 180; i++) document.cookie = "quota" + i + "=v; Path=/";
      });
      const events = await finishChanges(page, site === "jar");
      const survivors = await page.evaluate(() => cookieStore.getAll());
      const removed = events.flatMap((e) => e.deleted.map((c) => c.name));
      expect(survivors.length).toBeLessThan(181);
      expect(removed.length).toBe(182 - survivors.length);
      expect(events.flatMap((e) => e.changed)).toHaveLength(182);
      return { survivors, events, wire: await requestCookie(page) };
    },
    (native) => ({ ...native, events: syntheticChanges(native.events) }),
  );
});

test("CS-03 | explicit creation URL on a document loaded with a fragment", async ({ fixture }) => {
  await compareNative(fixture, "/page#initial", async () => {
    const result = await fixture.page.evaluate(async () => {
      const href = location.href;
      if (new URL(href).hash !== "#initial") throw new Error("Missing initial fragment");
      await cookieStore.set("fragment", "present");
      const explicit = [];
      for (const method of ["get", "getAll"] as const) {
        try {
          explicit.push(await cookieStore[method]({ name: "fragment", url: href }));
        } catch (error) {
          if (!(error instanceof TypeError)) throw error;
          explicit.push({ name: error.name, message: error.message });
        }
      }
      return { implicit: (await cookieStore.get("fragment"))?.value, explicit };
    });
    expect.soft(result).toEqual({
      implicit: "present",
      explicit: ["get", "getAll"].map((method) => ({
        name: "TypeError",
        message: `Failed to execute '${method}' on 'CookieStore': URL must match the document URL`,
      })),
    });
    return result;
  });
});
