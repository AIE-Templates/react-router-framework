import { expect, requestCookie, test } from "./fixture.ts";

test("SRV-04 | the last accepted Set-Cookie for an identity wins, including deletion", async ({ fixture }) => {
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    for (const { batch, expected } of [
      { batch: ["sid=1", "sid=2; HttpOnly"], expected: [{ value: "2", httpOnly: true }] },
      { batch: ["sid=1", "sid=" + "v".repeat(4096)], expected: [{ value: "1", httpOnly: false }] },
      { batch: ["sid=1", "sid=; Max-Age=0"], expected: [] },
      { batch: ["sid=; Max-Age=0"], expected: [] },
    ]) {
      await fixture.set(["sid=seed; HttpOnly"]);
      await fixture.set(batch);
      expect((await fixture.stored(site)).map(({ value, httpOnly }) => ({ value, httpOnly }))).toEqual(expected);
    }
    for (const [name, invalid] of [
      ["__Secure-sid", "new"],
      ["__Http-a", "new; Secure"],
      ["__http-b", "new; Secure"],
      ["sid", "new; SameSite=None"],
      ["sid", "v".repeat(4096)],
    ]) {
      await fixture.set([name + "=old; Secure; HttpOnly"]);
      await fixture.set([name + "=" + invalid]);
      expect((await fixture.stored(site)).find((c) => c.name === name)).toMatchObject({ value: "old", httpOnly: true });
    }
  }
});

test("SRV-04 | concurrently received ordinary batches preserve a complete response order", async ({ fixture }) => {
  const paths = await Promise.all([fixture.replyPath(["x=a", "y=a"]), fixture.replyPath(["y=b", "x=b"])]);
  for (let i = 0; i < 8; i++) {
    await fixture.page.evaluate(async (urls) => {
      await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(url);
          if (!response.ok) throw new Error("Set-Cookie batch returned " + response.status);
          await response.text();
        }),
      );
    }, paths);
    const cookies = await fixture.stored("jar");
    expect(cookies.map((c) => c.name)).toEqual(["x", "y"]);
    expect([
      ["a", "a"],
      ["b", "b"],
    ]).toContainEqual(cookies.map((c) => c.value));
  }
});

test("SRV-04 | a real store reader observes no missing or intermediate HttpOnly value during downgrades", async ({
  fixture,
}) => {
  await fixture.set(["sid=old; Path=/; HttpOnly"]);
  const reader = await fixture.app.evaluateHandle(({ session }) => {
    const controller = new AbortController();
    const run = async () => {
      const states = new Set<string>();
      let reads = 0;
      while (!controller.signal.aborted) {
        const cookies = await session.defaultSession.cookies.get({
          url: globalThis.cookieFixture.storageOrigin,
          name: "sid",
        });
        states.add(JSON.stringify(cookies.map((c) => [c.value, c.httpOnly])));
        reads++;
      }
      return { states: [...states].toSorted(), reads };
    };
    const result = run();
    return async () => {
      controller.abort();
      return result;
    };
  });
  try {
    for (let i = 0; i < 32; i++) {
      expect(await fixture.set(["sid=plain; Path=/"])).toBe("sid=old");
      expect(await fixture.set(["sid=old; Path=/; HttpOnly"])).toBe("sid=plain");
    }
  } finally {
    try {
      const observed = await reader.evaluate((stop) => stop());
      expect(observed.reads).toBeGreaterThan(1);
      expect(observed.states).toEqual(['[["old",true]]', '[["plain",false]]']);
    } finally {
      await reader.dispose();
    }
  }
});

for (const upstream of ["127.0.0.1", "app.desktop"]) {
  test.describe("upstream " + upstream, () => {
    test.use({ upstreamHost: upstream });
    test("SRV-05 | Domain and host-only identities match the ordinary HTTPS site", async ({ fixture }) => {
      const snapshots = [];
      for (const site of ["https", "jar"] as const) {
        const domain = site === "jar" ? upstream : new URL(fixture.origins.https).hostname;
        const parent = site === "jar" ? "desktop" : "test";
        await fixture.visit(site);
        await fixture.set([
          "sid=host; Path=/",
          "sid=domain; Path=/; Domain=." + domain.toUpperCase(),
          "__Host-invalid=x; Path=/; Secure; Domain=" + domain,
          "parent=x; Path=/; Domain=" + parent,
        ]);
        const cookies = await fixture.stored(site);
        expect(cookies).toHaveLength(2);
        expect(cookies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "sid", value: "host", domain: "HOST", hostOnly: true }),
            expect.objectContaining({ name: "sid", value: "domain", domain: ".HOST", hostOnly: false }),
          ]),
        );
        snapshots.push(cookies);
        expect((await requestCookie(fixture.page)).split("; ").toSorted()).toEqual(["sid=domain", "sid=host"]);
        if (site === "jar" && upstream === "127.0.0.1") {
          const url = await fixture.app.evaluate(() => globalThis.cookieFixture.websocket);
          await fixture.page.evaluate(
            (ws) =>
              new Promise<void>((resolve, reject) => {
                const socket = new WebSocket(ws);
                socket.addEventListener("open", () => resolve(), { once: true });
                socket.addEventListener("error", () => reject(new Error("HMR WebSocket handshake failed")), {
                  once: true,
                });
              }),
            url,
          );
          expect(await fixture.app.evaluate(() => globalThis.cookieFixture.socketCookie())).toBe("");
        }
        await fixture.set(["sid=; Max-Age=0; Path=/; Domain=" + domain]);
        expect(await requestCookie(fixture.page)).toBe("sid=host");
        await fixture.set(["sid=domain; Path=/; Domain=" + domain, "sid=; Path=/; Max-Age=0"]);
        expect(await requestCookie(fixture.page)).toBe("sid=domain");
      }
      expect(snapshots[1]).toEqual(snapshots[0]);
    });
  });
}

test("SRV-08 | match path boundaries, send longest first and delete just the matching identity", async ({
  fixture,
}) => {
  await fixture.set(["sid=root; Path=/", "sid=account; Path=/account"]);
  expect(await requestCookie(fixture.page, "/account")).toBe("sid=account; sid=root");
  expect(await requestCookie(fixture.page, "/account/deeper")).toBe("sid=account; sid=root");
  expect(await requestCookie(fixture.page, "/accounts")).toBe("sid=root");
  await fixture.set(["sid=; Path=/account; Max-Age=0"]);
  expect(await requestCookie(fixture.page, "/account")).toBe("sid=root");
});

test("SRV-08 | a hard kill preserves the latest persistent value and cannot resurrect a replaced one", async ({
  fixture,
  restart,
}) => {
  await fixture.set(["keep=before; Path=/", "drop=before; Max-Age=3600; Path=/"]);
  const previous = await fixture.set(["keep=after; Max-Age=3600; Path=/", "drop=after; Path=/"]);
  expect(previous.split("; ").toSorted()).toEqual(["drop=before", "keep=before"]);
  expect((await requestCookie(fixture.page)).split("; ").toSorted()).toEqual(["drop=after", "keep=after"]);
  const restarted = await restart("kill");
  expect(await requestCookie(restarted.page)).toBe("keep=after");
  expect((await restarted.stored("jar")).map(({ name, value, session }) => ({ name, value, session }))).toEqual([
    { name: "keep", value: "after", session: false },
  ]);
});

test("SRV-08 | a stalled store lookup returns 503 and the same request recovers", async ({ fixture }) => {
  await fixture.set(["sid=ok; Path=/"]);
  const fault = await fixture.app.evaluateHandle(({ session }) => {
    const cookies = session.defaultSession.cookies;
    // oxlint-disable-next-line typescript/unbound-method -- restore the exact method and invoke it with its original receiver
    const get = cookies.get;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    cookies.get = async (filter) => {
      if (filter.url === globalThis.cookieFixture.storageOrigin + "/stall") await gate;
      return get.call(cookies, filter);
    };
    return () => {
      cookies.get = get;
      release();
    };
  });
  try {
    expect(await fixture.page.evaluate(async () => (await fetch("/stall")).status)).toBe(503);
  } finally {
    await fault.evaluate((restore) => restore());
    await fault.dispose();
  }
  expect(await requestCookie(fixture.page, "/stall")).toBe("sid=ok");
});
