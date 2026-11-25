import { compareNative, expect, test } from "./fixture.ts";
import { command, observe, register, waitForChanges, windowSubscriptions, write } from "./service-worker-fixture.ts";

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
