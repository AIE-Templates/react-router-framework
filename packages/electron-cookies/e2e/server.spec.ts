import { compareNative, expect, requestCookie, test } from "./fixture.ts";

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
        expect(await requestCookie(fixture.page)).toBe("sid=host; sid=domain");
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
  expect(previous).toBe("keep=before; drop=before");
  expect(await requestCookie(fixture.page)).toBe("keep=after; drop=after");
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

for (const transition of [
  "upgrade",
  "downgrade",
  "colliding downgrades",
  "delete HttpOnly",
  "server delete",
  "document delete",
]) {
  test("SRV-04 | window change events on " + transition, async ({ fixture }) => {
    await compareNative(fixture, "/", async () => {
      const hidden = transition.includes("downgrade") || transition === "delete HttpOnly";
      await fixture.set(["sid=seed; Path=/" + (hidden ? "; HttpOnly" : "")]);
      const collector = await fixture.page.evaluateHandle(() => {
        const events: { changed: readonly CookieListItem[]; deleted: readonly CookieListItem[] }[] = [];
        const onChange = (event: CookieChangeEvent) => events.push({ changed: event.changed, deleted: event.deleted });
        cookieStore.addEventListener("change", onChange);
        return {
          events,
          stop() {
            cookieStore.removeEventListener("change", onChange);
          },
        };
      });
      try {
        // Fence both registration and delivery through the same listener and storage backend.
        await fixture.set(["fence=start; Path=/"]);
        const fence = (value: string) =>
          collector.evaluate(
            (log, v) => log.events.some((e) => e.changed.some((c) => c.name === "fence" && c.value === v)),
            value,
          );
        await expect.poll(() => fence("start")).toBe(true);
        await collector.evaluate((log) => {
          log.events.length = 0;
        });
        if (transition === "colliding downgrades") {
          const paths = await Promise.all(
            ["one", "two"].map((v) => fixture.replyPath(["sid=" + v + "; Path=/"], "/colliding-downgrades")),
          );
          const pair = encodeURIComponent(paths[0]);
          const sent = await Promise.all(paths.map((path) => requestCookie(fixture.page, path + "&pair=" + pair)));
          expect(sent).toEqual(["sid=seed; fence=start", "sid=seed; fence=start"]);
        } else if (transition === "document delete") {
          await fixture.page.evaluate(() => {
            document.cookie = "sid=; Path=/; Max-Age=0";
          });
        } else {
          const change =
            transition === "upgrade" ? "new; HttpOnly" : transition === "downgrade" ? "new" : "; Max-Age=0";
          await fixture.set(["sid=" + change + "; Path=/"]);
        }
        const final = await fixture.page.evaluate(() => cookieStore.get("sid"));
        await fixture.set(["fence=end; Path=/"]);
        await expect.poll(() => fence("end")).toBe(true);
        const events = await collector.evaluate((log) =>
          log.events.filter((e) => [...e.changed, ...e.deleted].some((c) => c.name === "sid")),
        );
        if (transition === "colliding downgrades") {
          // The two network responses may complete in either order. Match each observed write and its final state.
          expect(["one", "two"]).toContain(final?.value);
          const first = final!.value === "one" ? "two" : "one";
          expect(events.map((e) => [e.changed.map((c) => c.value), e.deleted])).toEqual([
            [[first], []],
            [[final!.value], []],
          ]);
          return events.map((e) => ({
            ...e,
            changed: e.changed.map((c) => ({ ...c, value: c.value === first ? "first" : "last" })),
          }));
        }
        expect(final?.value).toBe(transition === "downgrade" ? "new" : undefined);
        if (transition === "server delete" || transition === "document delete") {
          expect(events).toStrictEqual([
            {
              changed: [],
              deleted: [{ name: "sid", domain: null, path: "/", secure: false, partitioned: false }],
            },
          ]);
        }
        return events;
      } finally {
        await collector.evaluate((log) => log.stop());
        await collector.dispose();
      }
    });
  });
}

test("SRV-08 | overwrite and HttpOnly downgrade order on the wire and in document.cookie", async ({ fixture }) => {
  for (const site of ["localhost", "https", "jar"] as const) {
    await fixture.visit(site);
    const read = async () => [await requestCookie(fixture.page), await fixture.page.evaluate(() => document.cookie)];
    for (const [initial, replacement, expected] of [
      ["1", "2", "B=1; A=2"],
      ["1; HttpOnly", "2", "B=1; A=2"],
      ["1; HttpOnly", "1", site === "jar" ? "B=1; A=1" : "A=1; B=1"],
    ]) {
      await fixture.set(["A=; Max-Age=0; Path=/", "B=; Max-Age=0; Path=/"]);
      await fixture.set(["A=" + initial + "; Path=/"]);
      await fixture.set(["B=1; Path=/"]);
      await fixture.set(["A=" + replacement + "; Path=/"]);
      expect(await read(), site + " " + initial + " -> " + replacement).toEqual([expected, expected]);
    }
  }
});

test("SRV | one response with 60 Set-Cookie fields", async ({ fixture }) => {
  const pairs = Array.from({ length: 60 }, (_, index) => "field" + index + "=yes");
  for (const site of ["localhost", "https", "jar"] as const) {
    await fixture.visit(site);
    await fixture.set(pairs.map((pair) => pair + "; Path=/"));
    // The jar bounds concurrent Electron calls, including retries and isolated validation of rejected downgrades.
    const expected = site === "jar" ? pairs.slice(0, 50) : pairs;
    const sent = (await requestCookie(fixture.page)).split("; ");
    expect(sent, site).toHaveLength(expected.length);
    expect(new Set(sent), site).toEqual(new Set(expected));
    expect(await fixture.stored(site)).toHaveLength(expected.length);
  }
});
