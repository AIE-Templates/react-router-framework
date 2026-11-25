import { OMIT_COOKIES_HEADER } from "../src/shared.ts";
import { compareNative, expect, requestCookie, test } from "./fixture.ts";

test("SRV-07 | effective window credentials control request and response cookies", async ({ fixture }) => {
  await fixture.set(["sid=initial; Path=/"]);
  for (const [mode, credentials, expectedMarker, visible] of [
    ["cors", "omit", "1", false],
    ["cors", "include", null, true],
    ["no-cors", "omit", null, true],
  ] as const) {
    const path = await fixture.replyPath(["sid=" + credentials + "; Path=/"]);
    const before = await requestCookie(fixture.page);
    const observed = await fixture.page.evaluate(
      async (args) => {
        // An init override also exercises removal of a stale marker on a window Request.
        const request = new Request(args.path, {
          credentials: "omit",
          mode: args.mode,
          headers: args.credentials === "include" ? { [args.header]: "1" } : {},
        });
        return (await fetch(request, { credentials: args.credentials })).text();
      },
      { path, mode, credentials, header: OMIT_COOKIES_HEADER },
    );
    expect(observed).toBe(visible ? before : "");
    expect(await requestCookie(fixture.page)).toBe(visible ? "sid=" + credentials : before);
    expect(await fixture.app.evaluate((_e, url) => globalThis.cookieFixture.network(url), path)).toEqual({
      marker: expectedMarker,
      wire: [{ method: "GET", marker: null }],
    });
  }
  const remote = await fixture.replyPath(["remote=ignored; Secure; SameSite=None; Path=/"]);
  expect(
    await fixture.page.evaluate(
      async (url) => (await fetch(url, { credentials: "omit" })).text(),
      fixture.origins.https + remote,
    ),
  ).toBe("");
  const report = await fixture.app.evaluate((_e, url) => globalThis.cookieFixture.network(url), remote);
  expect(report.wire).toEqual([{ method: "GET", marker: null }]);
  expect(await fixture.stored("https")).toEqual([]);
});

test("DC-25 | fetch returns rejected promises, evaluates getters once and uses Request internal slots", async ({
  fixture,
}) => {
  await compareNative(fixture, "/", async () => {
    await fixture.set(["sid=original; Path=/"]);
    const path = await fixture.replyPath(["side=effect; Path=/"]);
    const results = await fixture.page.evaluate(async (url) => {
      let reads = 0;
      const throwing = {
        get credentials(): RequestCredentials {
          reads++;
          if (reads === 1) throw new RangeError("first access");
          return "include";
        },
      };
      const operations = [
        () => fetch("http://["),
        // oxlint-disable-next-line unicorn/no-invalid-fetch-options -- Rejection of GET with a body is under test.
        () => fetch("/", { method: "GET", body: "x" }),
        () => Reflect.apply(fetch, window, []),
        () => fetch(url, throwing),
      ];
      const errors = [];
      for (const run of operations) {
        const pending = run();
        try {
          await pending;
          errors.push(null);
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          errors.push(err.name);
        }
      }
      const req = new Request("/echo", { credentials: "omit" });
      Object.defineProperties(req, {
        credentials: { get: () => "include" },
        url: { get: () => "https://elsewhere.test/" },
      });
      return { errors, reads, body: await (await fetch(req)).text() };
    }, path);
    expect(results).toEqual({ errors: ["TypeError", "TypeError", "TypeError", "RangeError"], reads: 1, body: "" });
    const network = await fixture.app.evaluate((_e, url) => globalThis.cookieFixture.network(url), path);
    expect(network.wire).toEqual([]);
    return results;
  });
});

test("SRV-07 | window fetch defaults to same-origin credentials", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    await fixture.set(["sid=before; Path=/"]);
    const path = await fixture.replyPath(["sid=after; Path=/"]);
    const result = [await requestCookie(fixture.page, path), await requestCookie(fixture.page)];
    expect(result).toEqual(["sid=before", "sid=after"]);
    return result;
  });
});
