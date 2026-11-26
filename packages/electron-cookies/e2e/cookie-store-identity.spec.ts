import { compareNative, expect, test } from "./fixture.ts";
import {
  command,
  index,
  observe,
  register,
  scope,
  waitForChanges,
  windowSubscriptions,
  write,
} from "./service-worker-fixture.ts";

test("window CookieStore identity, global descriptor, prototype read and change event trust", async ({ fixture }) => {
  await compareNative(fixture, "/", async (site) => {
    const result = await fixture.page.evaluate(async () => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Serialized by Playwright into the page.
      const descriptor = (target: object) => {
        const d = Object.getOwnPropertyDescriptor(target, "cookieStore");
        return (
          d && {
            enumerable: d.enumerable,
            configurable: d.configurable,
            get: d.get?.name,
            set: d.set?.name,
            writable: d.writable,
          }
        );
      };
      const changed = new Promise<{ instance: boolean; trusted: boolean }>((resolve) =>
        cookieStore.addEventListener(
          "change",
          (event) =>
            resolve({
              instance: event instanceof CookieChangeEvent,
              trusted: event.isTrusted,
            }),
          { once: true },
        ),
      );
      await cookieStore.set("identity", "window");
      return {
        type: typeof CookieStore,
        constructor: cookieStore.constructor.name,
        sameConstructor: cookieStore.constructor === CookieStore,
        instance: cookieStore instanceof CookieStore,
        prototype: Object.getPrototypeOf(cookieStore) === CookieStore.prototype,
        tag: Object.prototype.toString.call(cookieStore),
        global: descriptor(window),
        inherited: descriptor(Window.prototype),
        read: await CookieStore.prototype.get.call(cookieStore, { name: "identity" }),
        event: await changed,
      };
    });
    expect(result.read?.value).toBe("window");
    const { event, ...identity } = result;
    expect(event).toEqual({ instance: true, trusted: site !== "jar" });
    return identity;
  });
});

test("worker CookieStore identity, global descriptor, prototype read and cookiechange event trust", async ({
  fixture,
}) => {
  const results = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    await observe(fixture.page);
    await register(fixture.page);
    await windowSubscriptions(fixture.page, "subscribe", "identity");
    await write(fixture.page, "identity", "worker");
    const [event] = await waitForChanges(fixture.page, 1);
    expect({ instance: event.instance, trusted: event.trusted }).toEqual({ instance: true, trusted: site === "https" });
    const identity = await command(fixture.page, { kind: "identity" });
    expect(identity).toMatchObject({ read: { value: "worker" } });
    results.push(identity);
  }
  expect(results[1]).toEqual(results[0]);
});

for (const source of ["EventTarget.prototype", "document", "child document", "child onchange setter"] as const) {
  test(`CS-11 | first change listener borrowed from ${source} receives the mutation`, async ({ fixture }) => {
    await compareNative(fixture, "/", async () => {
      const result = await fixture.page.evaluate(async (from) => {
        let target: EventTarget = from === "EventTarget.prototype" ? EventTarget.prototype : document;
        let onchange: PropertyDescriptor | undefined;
        if (from === "child document" || from === "child onchange setter") {
          const frame = document.createElement("iframe");
          const loaded = new Promise<void>((resolve) =>
            frame.addEventListener("load", () => resolve(), { once: true }),
          );
          frame.src = "/listener-client";
          document.body.append(frame);
          await loaded;
          target = frame.contentDocument!;
          if (from === "child onchange setter") {
            onchange = Object.getOwnPropertyDescriptor(frame.contentWindow!.window.CookieStore.prototype, "onchange");
          }
        }
        const changed = new Promise<string[]>((resolve) => {
          const listener = (event: Event) => {
            if (event instanceof CookieChangeEvent) resolve(event.changed.map((cookie) => cookie.name!));
          };
          if (from === "child onchange setter") onchange!.set!.call(cookieStore, listener);
          else target.addEventListener.call(cookieStore, "change", listener, { once: true });
        });
        await cookieStore.set("borrowed", "first");
        return { own: Object.hasOwn(CookieStore.prototype, "addEventListener"), names: await changed };
      }, source);
      expect(result).toEqual({ own: false, names: ["borrowed"] });
      return result;
    });
  });
}

test("SW-06 | borrowed manager methods accept a callable iterable and update the receiver's subscriptions", async ({
  fixture,
}) => {
  await compareNative(fixture, "/", async (site) => {
    const { page } = fixture;
    await register(page);
    await page.evaluate(async () => {
      const frame = document.createElement("iframe");
      const ready = new Promise<void>((resolve) => frame.addEventListener("load", () => resolve(), { once: true }));
      frame.src = "/subscription-client";
      document.body.append(frame);
      await ready;
    });
    const rows = [];
    for (const kind of ["subscribe", "unsubscribe"] as const) {
      const result = await page.evaluate(
        async ({ operation, url }) => {
          const child = document.querySelector("iframe")!.contentWindow!;
          const reg = await child.navigator.serviceWorker.getRegistration(url);
          if (!reg || Object.getPrototypeOf(reg.cookies) === CookieStoreManager.prototype)
            throw new Error("Expected a manager from the child realm");
          let iterations = 0;
          const sequence = Object.assign(() => {}, {
            *[Symbol.iterator]() {
              iterations++;
              yield { name: "borrowed", url: "page" };
            },
          });
          await Reflect.apply(CookieStoreManager.prototype[operation], reg.cookies, [sequence]);
          return {
            iterations,
            entries: (await reg.cookies.getSubscriptions()).map(({ name, url: target }) => ({
              name,
              path: target && new URL(target).pathname,
            })),
          };
        },
        { operation: kind, url: scope },
      );
      const subscribing = kind === "subscribe";
      expect(result).toEqual({
        iterations: 1,
        entries: subscribing ? [{ name: "borrowed", path: scope + "page" }] : [],
      });
      if (site === "jar")
        expect(await index(fixture)).toEqual(
          subscribing
            ? [
                expect.objectContaining({
                  name: "borrowed",
                  scope: fixture.origins.jar + scope,
                  url: fixture.origins.jar + scope + "page",
                  eligible: true,
                }),
              ]
            : [],
        );
      rows.push(result);
    }
    return rows;
  });
});

test("CS-11 | a listener installed through native about:blank starts receiving jar changes after window registration", async ({
  fixture,
}) => {
  await compareNative(
    fixture,
    "/",
    async (site) => {
      const { page } = fixture;
      const peer = await fixture.peer(site, "/listener-peer");
      try {
        await peer.evaluate(() => {
          cookieStore.addEventListener("change", (e) => {
            if (e.changed.some((c) => c.name === "before")) document.body.dataset.seen = "before";
          });
        });
        await page.evaluate(() => {
          const frame = document.createElement("iframe");
          document.body.append(frame);
          document.body.dataset.changes = "";
          frame.contentDocument!.addEventListener.call(cookieStore, "change", (e) => {
            if (e instanceof CookieChangeEvent)
              for (const item of e.changed) document.body.dataset.changes += item.name + ",";
          });
        });
        await page.evaluate(() => cookieStore.set("before", "1"));
        // The peer fences the first change before the receiving window registers.
        await peer.waitForFunction(() => document.body.dataset.seen === "before");
        await page.evaluate(async () => {
          cookieStore.addEventListener("change", () => {}, { once: true });
          await cookieStore.set("after", "2");
        });
        await page.waitForFunction(() => document.body.dataset.changes?.includes("after,"));
        const seen = await page.evaluate(() => document.body.dataset.changes);
        expect(seen).toBe(site === "jar" ? "after," : "before,after,");
        return seen;
      } finally {
        await peer.close();
      }
    },
    () => "after,",
  );
});
