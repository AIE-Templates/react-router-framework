import { compareNative, expect, requestCookie, test } from "./fixture.ts";

test("DC-01..10, DC-12, DC-15 | synchronous reads, writes, conversion and document URL", async ({ fixture }) => {
  const { page } = fixture;
  const expiresAt = new Date(Date.now() + 3600_000).toUTCString();
  await compareNative(fixture, "/account/page", async (site) => {
    await fixture.set(["sid=secret; Path=/; HttpOnly", "order=root; Path=/", "order=scoped; Path=/account"]);
    const setPath = await fixture.replyPath(["server=arrived; Path=/"]);
    const observations = await page.evaluate(
      async ({ path, expiry }) => {
        const response = await fetch(path);
        if (!response.ok) throw new Error(String(response.status));
        const immediate = document.cookie;
        const writes = [
          "bare; Path=/",
          "key=first; extra=ignored",
          "key=replaced",
          "tabs=ok;\tPath\t=\t/\t",
          "sid=changed; Path=/",
          "sid=; Max-Age=0; Path=/",
          "secret=no; HttpOnly",
          "exp=1; Expires=" + expiry,
          "capped=1; Max-Age=999999999",
          "strict=1; Secure; SameSite=Strict",
          "none=bad; SameSite=None",
          "__Host-no-path=x; Secure",
          "__Host-valid=x; Path=/; Secure",
          "__Secure-plain=x",
          "foreign=bad; Domain=invalid.test",
          "bad=value\x01suffix",
          "bad\x7fname=forbidden",
          "bad=tab; Path=/a\tb",
          "bad=tab; Unknown=a\tb",
          "bad=ctl; Path=/a\x01b",
          "bad=ctl; Unknown=a\x01b",
          "oversize=" + "x".repeat(4096),
          "gone=1",
          "gone=; Max-Age=0",
          "old=1",
          "old=; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ];
        const after = writes.map((line) => {
          document.cookie = line;
          return document.cookie;
        });
        const hints: string[] = [];
        Reflect.set(document, "cookie", {
          [Symbol.toPrimitive](hint: string) {
            hints.push(hint);
            return "coercion=" + hint;
          },
        });
        let symbolError;
        try {
          Reflect.set(document, "cookie", Symbol("cookie"));
        } catch (error) {
          symbolError = error instanceof TypeError;
        }
        history.pushState({}, "", "/elsewhere/page");
        document.cookie = "created=original";
        return { immediate, after, hints, symbolError, pushed: document.cookie };
      },
      { path: setPath, expiry: expiresAt },
    );
    expect(observations.immediate).toContain("server=arrived");
    expect(observations.immediate).not.toContain("sid=");
    expect(observations.hints).toEqual(["string"]);
    expect(observations.symbolError).toBe(true);
    expect(observations.pushed).toContain("order=scoped");
    const account = await requestCookie(page, "/account/wire");
    expect(account).toContain("sid=secret");
    expect(account).toContain("created=original");
    expect(await requestCookie(page, "/elsewhere/echo")).not.toContain("created=");
    const records = await fixture.stored(site);
    const capped = records.find((c) => c.name === "capped")?.expirationDate ?? 0;
    expect(Math.round((capped - Date.now() / 1000) / 86400)).toBe(400);
    const documentResponse = await page.goto(fixture.origins[site] + "/account/navigation");
    expect(await documentResponse!.text()).toBe(account);
    return {
      observations,
      account,
      records: records.map((c) => (c.name === "capped" ? { ...c, expirationDate: 400 } : c)),
    };
  });
});

test("DC-03 | script Paths match native on the wire for every printable ASCII character", async ({ fixture }) => {
  await compareNative(fixture, "/", () =>
    fixture.page.evaluate(async () => {
      const paths = [
        "/文档",
        "/a b",
        "/a/../b",
        "/a\\b",
        "/a?x=1",
        "/a|b",
        ...Array.from({ length: 95 }, (_, i) => "/ascii" + i + "/a" + String.fromCharCode(32 + i) + "b"),
      ];
      const outcomes: string[] = [];
      for (const [i, path] of paths.entries()) {
        document.cookie = "path" + i + "=ok; Path=" + path;
        // Chromium's URL parser treats HTTP backslashes as separators; use the same request path on every site.
        const target = new URL(path, "https://cookie.test");
        const result = await fetch(target.pathname + target.search);
        outcomes.push(await result.text());
      }
      return outcomes;
    }),
  );
});

test("DC-11 | detached documents retain their native cookie accessors", async ({ fixture }) => {
  await compareNative(fixture, "/", () =>
    fixture.page.evaluate(() => {
      document.cookie = "owner=live";
      return [
        document.implementation.createHTMLDocument("detached"),
        new DOMParser().parseFromString("<p/>", "text/html"),
      ].map((other) => {
        try {
          other.cookie = "owner=detached";
          return { value: other.cookie, live: document.cookie };
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          return { error: err.name, live: document.cookie };
        }
      });
    }),
  );
});

test("DC-04a, CS-15 | Partitioned is Secure and shares the ordinary identity only in the jar", async ({ fixture }) => {
  for (const site of ["https", "localhost", "jar"] as const) {
    await fixture.visit(site);
    const result = await fixture.page.evaluate(async () => {
      document.cookie = "p=invalid; Partitioned";
      const invalid = document.cookie;
      document.cookie = "p=one; Partitioned; Secure";
      const single = document.cookie;
      document.cookie = "p=two; Secure";
      const collision = document.cookie.split("; ").toSorted();
      document.cookie = "p=three; Secure; Partitioned";
      const reversed = document.cookie.split("; ").toSorted();
      await cookieStore.set({ name: "part", value: "api", partitioned: true });
      const item = await cookieStore.get("part");
      await cookieStore.delete({ name: "part", partitioned: true });
      return { invalid, single, collision, reversed, item, deleted: await cookieStore.get("part") };
    });
    expect(result).toEqual({
      invalid: "",
      single: "p=one",
      collision: site === "jar" ? ["p=two"] : ["p=one", "p=two"],
      reversed: site === "jar" ? ["p=three"] : ["p=three", "p=two"],
      item: {
        name: "part",
        value: "api",
        domain: null,
        path: "/",
        secure: true,
        sameSite: "strict",
        expires: null,
        partitioned: site !== "jar",
      },
      deleted: null,
    });
  }
});

test("DC-14 | clean restart preserves persistent script cookies only", async ({ fixture, restart }) => {
  await fixture.page.evaluate(() => {
    document.cookie = "keep=one; Max-Age=3600";
    document.cookie = "drop=two";
  });
  expect(await requestCookie(fixture.page)).toBe("keep=one; drop=two");
  const next = await restart("quit");
  expect(await next.page.evaluate(() => document.cookie)).toBe("keep=one");
});

test("DC-17/17a | script, structured and server Domain writes share an identity separate from host-only", async ({
  fixture,
}) => {
  // A single-label native localhost treats its own Domain as host-only. Compare the ordinary domain here.
  const observations = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    const siteDomain = new URL(fixture.origins[site]).hostname;
    await fixture.set(["id=host; Path=/", "id=server; Path=/; Domain=" + (site === "jar" ? "127.0.0.1" : siteDomain)]);
    observations.push(
      await fixture.page.evaluate(async () => {
        const domain = location.hostname;
        const rows = async () =>
          (await cookieStore.getAll("id")).map((c) => ({
            ...c,
            domain: "domain" in c && c.domain === domain ? "HOST" : "domain" in c ? c.domain : undefined,
          }));
        const before = await rows();
        document.cookie = "id=script; Domain=." + domain;
        const script = await rows();
        document.cookie = "id=; Domain=" + domain + "; Max-Age=0";
        const removed = await rows();
        await cookieStore.set({ name: "id", value: "api", domain });
        const structured = await rows();
        await cookieStore.delete({ name: "id", domain });
        return { before, script, removed, structured, end: await rows() };
      }),
    );
  }
  expect(observations[1]).toEqual(observations[0]);
  expect(observations[1].script).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ domain: "HOST", value: "script" }),
      expect.objectContaining({ domain: null, value: "host" }),
    ]),
  );
  expect(observations[1].end).toEqual([expect.objectContaining({ domain: null, value: "host" })]);
});

test("DC-24 | script and server exchange UTF-8 bytes and the jar ignores invalid UTF-8", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    await fixture.page.evaluate(() => {
      document.cookie = "out=中文";
    });
    const sent = await fixture.set([Buffer.from("in=中文; Path=/").toString("latin1")]);
    expect(sent).toBe(Buffer.from("out=中文").toString("latin1"));
    const visible = await fixture.page.evaluate(() => document.cookie);
    expect(visible).toContain("in=中文");
    return { sent, visible };
  });
  await fixture.set(["invalid=\xe9; Path=/"]);
  expect((await fixture.stored("jar")).map((c) => c.name)).not.toContain("invalid");
});
