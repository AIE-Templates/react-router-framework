import { compareNative, expect, requestCookie, test, type Site } from "./fixture.ts";

const sites = ["localhost", "https", "jar"] as const;
const bytes = (value: string) => Buffer.from(value).toString("latin1");

test("SRV-01/02/03a | stored fields, defaults and pre-1601 deletion match native Chromium", async ({ fixture }) => {
  const inputs = [
    "defaults=1",
    "strict=2; HttpOnly; Secure; SameSite=Strict",
    "none=3; SameSite=None; Secure",
    "insecure=bad; SameSite=None",
    "__Host-missing=bad; Secure",
    "__Host-valid=ok; Secure; Path=/",
    "wide=ok; Path=/" + "p".repeat(1024),
    "limit=ok; Path=/" + "p".repeat(1023),
    "relative=ok; Path=relative",
    "empty=ok; Path=",
    "last=ok; Path=/old; Path=relative",
    "gap=bad; Path=/a\tb",
    "extension=bad; Ignored=x\ty",
    "trim=ok;\tPath\t=\t/trim\t; HttpOnly",
    "over=1" + "v".repeat(4096),
    'quoted="q"',
    "equals=x=y",
    bytes("unicode=中文"),
    "old=gone; Expires=01 Jan 1600 00:00:00 GMT",
    "nameless",
    "partitionBad=v; Partitioned",
  ];
  const snapshots = new Map<Site, Awaited<ReturnType<typeof fixture.stored>>>();
  for (const site of sites) {
    await test.step(site, async () => {
      await fixture.visit(site);
      await fixture.set(["old=seed"]);
      expect(await requestCookie(fixture.page, "/account/echo")).toBe("old=seed");
      await fixture.set(inputs);
      const cookies = await fixture.stored(site);
      snapshots.set(site, cookies);
      expect(cookies.map((c) => c.name)).toEqual([
        "",
        "__Host-valid",
        "defaults",
        "empty",
        "equals",
        "last",
        "limit",
        "none",
        "quoted",
        "relative",
        "strict",
        "trim",
        "unicode",
        "wide",
      ]);
      for (const name of ["defaults", "empty", "relative", "last", "wide"]) {
        expect(cookies.find((c) => c.name === name)).toMatchObject({
          path: "/account",
          domain: "HOST",
          hostOnly: true,
          secure: false,
          httpOnly: false,
          sameSite: "unspecified",
          session: true,
        });
      }
      expect(cookies.find((c) => c.name === "limit")?.path).toBe("/" + "p".repeat(1023));
      expect(cookies.find((c) => c.name === "strict")).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: "strict",
      });
      expect(cookies.find((c) => c.name === "unicode")?.value).toBe("中文");
      expect(cookies.find((c) => !c.name)?.value).toBe("nameless");
      const sent = (await requestCookie(fixture.page, "/account/echo")).split("; ");
      expect(sent).toContain(bytes("unicode=中文"));
    });
  }
  expect(snapshots.get("jar")).toEqual(snapshots.get("https"));
  expect(snapshots.get("jar")).toEqual(snapshots.get("localhost"));
});

test("SRV-01 | unreachable literal Paths, control bytes and non-UTF-8 wire values", async ({ fixture }) => {
  const nativeTransport = new Map<string, number | string>();
  const paths = ["/文档", "/a b", "/a/../b", "/a\\b", "/a?x=1", "/a|b"];
  for (const site of sites) {
    await test.step(site, async () => {
      await fixture.visit(site);
      await fixture.set(paths.map((path, i) => bytes("unreachable" + i + "=bad; Path=" + path)));
      for (const path of [...paths, "/a%7Cb", "/a%5Cb", "/a%3Fx=1"]) {
        expect(await requestCookie(fixture.page, path), path).toBe("");
      }
      const stored = await fixture.stored(site);
      if (site === "jar") expect(stored).toEqual([]);
      else expect(stored.map((c) => c.path)).toEqual(paths);
      for (const path of ["/control-in-path", "/control-in-extension"]) {
        const result = await fixture.page.evaluate(async (url) => {
          try {
            return (await fetch(url)).status;
          } catch (error) {
            if (error instanceof TypeError) return "transport rejection";
            throw error;
          }
        }, path);
        if (site === "jar") expect(result).toBe(200);
        else if (site === "localhost") nativeTransport.set(path, result);
        else expect(result).toBe(nativeTransport.get(path));
        // A valid sibling proves whether Chromium reached cookie processing for this malformed HTTP response.
        const sibling = (await fixture.stored(site)).some((c) => c.name === "control-witness");
        expect(sibling).toBe(result === 200);
        await fixture.set(["control-witness=; Path=/; Max-Age=0"]);
        expect((await fixture.stored(site)).filter((c) => c.name.startsWith("ctl"))).toEqual([]);
      }
      await fixture.set(["invalid=\xff; Path=/", "ok=1; Path=/"]);
      const sent = (await requestCookie(fixture.page)).split("; ");
      expect(sent).toEqual(site === "jar" ? ["ok=1"] : ["invalid=\xff", "ok=1"]);
      if (site === "jar") expect((await fixture.stored(site)).map((c) => c.name)).toEqual(["ok"]);
    });
  }
});

test("SRV-03 | nameless cookies are sent as bare values and can be removed", async ({ fixture }) => {
  for (const site of sites) {
    await fixture.visit(site);
    for (const line of ["bare", "=explicit"]) {
      await fixture.set([line + "; Path=/"]);
      expect((await fixture.stored(site)).map(({ name, value }) => [name, value])).toEqual([
        ["", line.replace(/^=/, "")],
      ]);
      expect(await requestCookie(fixture.page)).toBe(line.replace(/^=/, ""));
    }
    await fixture.set(["=; Path=/; Max-Age=0"]);
    expect(await requestCookie(fixture.page)).toBe("explicit");
    await fixture.set(["=delete; Path=/; Max-Age=0"]);
    expect(await fixture.stored(site)).toEqual([]);
    expect(await requestCookie(fixture.page)).toBe("");
  }
});

test("SRV-01/04 | an empty value deletes an HttpOnly cookie at the name-size limit", async ({ fixture }) => {
  const name = "n".repeat(4096);
  await compareNative(fixture, "/", async () => {
    await fixture.set([name + "=; Path=/; HttpOnly"]);
    expect(await requestCookie(fixture.page)).toBe(name + "=");
    await fixture.set([name + "=; Max-Age=0; Path=/"]);
    const sent = await requestCookie(fixture.page);
    expect(sent).toBe("");
    return sent;
  });
});

test("SRV-01/03b | Partitioned identity on the wire and deletion in both directions", async ({ fixture }) => {
  for (const site of sites) {
    await test.step(site, async () => {
      await fixture.visit(site);
      const set = async (line: string) => {
        await fixture.set([line + "; Path=/"]);
        return (await requestCookie(fixture.page)).split("; ").filter(Boolean);
      };
      expect(await set("sid=bad; Partitioned")).toEqual([]);
      expect(await set("sid=part; Secure; Partitioned")).toEqual(["sid=part"]);
      // Electron.Cookies has no partition key. Playwright reads Chromium's store via CDP.
      const url = site === "jar" ? fixture.storageOrigin : fixture.origins[site];
      const records = await fixture.app.context().cookies(url);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ name: "sid", value: "part", path: "/", secure: true, httpOnly: false });
      if (site === "jar") expect(records[0].partitionKey).toBeUndefined();
      else expect(records[0].partitionKey).toBe(new URL(url).protocol + "//" + new URL(url).hostname);
      expect(await set("sid=plain; Secure")).toEqual(site === "jar" ? ["sid=plain"] : ["sid=part", "sid=plain"]);
      expect(await set("sid=; Secure; Max-Age=0")).toEqual(site === "jar" ? [] : ["sid=part"]);
      await set("sid=plain; Secure");
      expect(await set("sid=part; Secure; Partitioned")).toEqual(
        site === "jar" ? ["sid=part"] : ["sid=part", "sid=plain"],
      );
      expect(await set("sid=; Secure; Partitioned; Max-Age=0")).toEqual(site === "jar" ? [] : ["sid=plain"]);
    });
  }
});

test("SRV-06 | Expires follows server Date while Max-Age follows elapsed local time", async ({ fixture }) => {
  for (const offset of [-86400, 86400]) {
    const server = Date.now() + offset * 1000;
    const expires = new Date(server + 3600_000).toUTCString();
    const lifetimes = [];
    for (const site of sites) {
      await fixture.visit(site);
      const before = Date.now() / 1000;
      await fixture.set(
        ["skew=1; Expires=" + expires, "max=2; Max-Age=60; Expires=" + expires],
        "/set",
        new Date(server).toUTCString(),
      );
      const after = Date.now() / 1000;
      const cookies = await fixture.stored(site);
      const observed = [];
      for (const [name, seconds] of [
        ["skew", 3600],
        ["max", 60],
      ] as const) {
        const expiry = cookies.find((c) => c.name === name)?.expirationDate;
        expect(expiry, site + " " + name).toBeDefined();
        expect(expiry!).toBeGreaterThanOrEqual(before + seconds - 1);
        expect(expiry!).toBeLessThanOrEqual(after + seconds + 1);
        observed.push(Math.round((expiry! - before) / 60));
      }
      lifetimes.push(observed);
    }
    expect(lifetimes).toEqual([
      [60, 1],
      [60, 1],
      [60, 1],
    ]);
  }
});

test("SRV-01 | prefixes, SameSite and a later invalid attribute", async ({ fixture }) => {
  await compareNative(fixture, "/", async (site) => {
    const future = new Date(Date.now() + 3600_000).toUTCString();
    await fixture.set([
      "__Secure-one=v; Secure",
      "__sEcUrE-two=v",
      "__Http-one=v; Secure; HttpOnly",
      "__hTtP-two=v; Secure",
      "__Host-Http-one=v; Path=/; Secure; HttpOnly",
      "__HoSt-HtTp-two=v; Path=/; Secure",
      "__HoSt-HtTp-three=v; Secure; HttpOnly",
      "lax=v; SameSite=Lax",
      "unknown=v; SameSite=bogus",
      "duplicateSite=v; SameSite=Strict; SameSite=bogus",
      "duplicateAge=v; Max-Age=60; Max-Age=bad",
      "duplicateExpiry=v; Expires=" + future + "; Expires=bad",
    ]);
    const cookies = await fixture.stored(site);
    expect(cookies).toHaveLength(8);
    for (const name of ["__Secure-one", "__Http-one", "__Host-Http-one"]) {
      expect(cookies.find((c) => c.name === name)).toMatchObject({ secure: true, httpOnly: name !== "__Secure-one" });
    }
    expect(cookies.find((c) => c.name === "lax")?.sameSite).toBe("lax");
    for (const name of ["unknown", "duplicateSite", "duplicateAge", "duplicateExpiry"]) {
      expect(cookies.find((c) => c.name === name)).toMatchObject({ sameSite: "unspecified", session: true });
    }
    return cookies;
  });
});

test("SRV-01 | Domain with empty, dotted, exact and unrelated hosts", async ({ fixture }) => {
  const snapshots = [];
  for (const site of ["https", "jar"] as const) {
    await fixture.visit(site);
    const host = site === "jar" ? "127.0.0.1" : new URL(fixture.origins[site]).hostname;
    await fixture.set([
      "empty=v; Domain=",
      "dot=v; Domain=.",
      "double=v; Domain=.." + host,
      "exact=v; Domain=" + host,
      "leading=v; Domain=." + host.toUpperCase(),
      "foreign=v; Domain=other.test",
    ]);
    const cookies = await fixture.stored(site);
    expect(cookies.map((c) => [c.name, c.domain, c.hostOnly])).toEqual([
      ["empty", "HOST", true],
      ["exact", ".HOST", false],
      ["leading", ".HOST", false],
    ]);
    snapshots.push(cookies);
  }
  expect(snapshots[1]).toEqual(snapshots[0]);
});

test("SRV-01 | future Expires and Max-Age including the 400-day ceiling", async ({ fixture }) => {
  await compareNative(fixture, "/", async (site) => {
    const now = Date.now();
    const date = new Date(now).toUTCString();
    await fixture.set(
      [
        "expires=v; Expires=" + new Date(now + 3600_000).toUTCString(),
        "age=v; Max-Age=60",
        "capExpires=v; Secure; Expires=Fri, 31 Dec 9999 23:59:59 GMT",
        "capAge=v; Secure; Max-Age=999999999",
      ],
      "/set",
      date,
    );
    const end = Date.now();
    const cookies = await fixture.stored(site);
    expect(cookies.map((c) => c.name)).toEqual(["age", "capAge", "capExpires", "expires"]);
    return cookies.map(({ name, expirationDate, ...cookie }) => {
      const seconds = name.startsWith("cap") ? 400 * 86400 : name === "age" ? 60 : 3600;
      expect(expirationDate, name).toBeGreaterThanOrEqual(now / 1000 + seconds - 1);
      expect(expirationDate, name).toBeLessThanOrEqual(end / 1000 + seconds + 1);
      return { name, ...cookie, lifetime: seconds };
    });
  });
});
