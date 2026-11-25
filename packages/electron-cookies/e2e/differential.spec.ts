import { expect, requestCookie, test, type Site } from "./fixture.ts";

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
      expect(cookies.map((c) => c.name).toSorted()).toEqual(
        [
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
        ].toSorted(),
      );
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
        else expect([200, "transport rejection"]).toContain(result);
        expect((await fixture.stored(site)).filter((c) => c.name.startsWith("ctl"))).toEqual([]);
      }
      await fixture.set(["invalid=\xff; Path=/", "ok=1; Path=/"]);
      const sent = (await requestCookie(fixture.page)).split("; ").toSorted();
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
    await fixture.set(["=delete; Path=/; Max-Age=0"]);
    expect(await fixture.stored(site)).toEqual([]);
    expect(await requestCookie(fixture.page)).toBe("");
  }
});

test("SRV-01/03b | Partitioned identity on the wire and deletion in both directions", async ({ fixture }) => {
  for (const site of sites) {
    await test.step(site, async () => {
      await fixture.visit(site);
      const set = async (line: string) => {
        await fixture.set([line + "; Path=/"]);
        return (await requestCookie(fixture.page)).split("; ").filter(Boolean).toSorted();
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
