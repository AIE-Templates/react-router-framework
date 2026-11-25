import { OMIT_COOKIES_HEADER } from "../src/shared.ts";
import { compareNative, expect, requestCookie, test } from "./fixture.ts";

for (const status of [302, 303, 307]) {
  test("redirect " + status + " | fetch and form navigation apply cookies before the next hop", async ({ fixture }) => {
    await compareNative(fixture, "/", async (site) => {
      const results = [];
      for (const client of ["fetch", "form"]) {
        for (const absolute of [false, true]) {
          const value = client + Number(absolute);
          const next = await fixture.replyPath([], "/inspect");
          const first = await fixture.replyPath(["hop=" + value + "; Path=/"], "/redirect");
          const path =
            first + "&status=" + status + "&next=" + encodeURIComponent(next) + (absolute ? "&absolute" : "");
          let body: string;
          if (client === "fetch") {
            const observed = await fixture.page.evaluate(async (url) => {
              const response = await fetch(url, { method: "POST", body: new URLSearchParams({ field: "value" }) });
              return { body: await response.text(), url: response.url, redirected: response.redirected };
            }, path);
            expect(observed).toMatchObject({ redirected: true, url: fixture.origins[site] + next });
            body = observed.body;
          } else {
            await Promise.all([
              fixture.page.waitForURL(fixture.origins[site] + next),
              fixture.page.evaluate((url) => {
                const form = document.createElement("form");
                const input = document.createElement("input");
                input.name = "field";
                input.value = "value";
                form.append(input);
                form.method = "POST";
                form.action = url;
                document.body.append(form);
                form.submit();
              }, path),
            ]);
            body = await fixture.page.locator("body").innerText();
          }
          expect(await fixture.app.evaluate((_e, p) => globalThis.cookieFixture.network(p).wire, first)).toEqual([
            { method: "POST", marker: null },
          ]);
          const report: unknown = JSON.parse(body);
          expect(report).toMatchObject({
            cookie: "hop=" + value,
            method: status === 307 ? "POST" : "GET",
            body: status === 307 ? "field=value" : "",
          });
          results.push(report);
        }
      }
      return results;
    });
  });
}

test('redirect: "manual" hides the response and applies only the first hop', async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    const next = await fixture.replyPath(["next=bad; Path=/"]);
    const path = await fixture.replyPath(["first=ok; Path=/"], "/redirect");
    const result = await fixture.page.evaluate(
      async (url) => {
        const response = await fetch(url, { redirect: "manual" });
        return [response.status, response.type, response.redirected, [...response.headers], await response.text()];
      },
      path + "&status=302&next=" + encodeURIComponent(next),
    );
    expect(result).toEqual([0, "opaqueredirect", false, [], ""]);
    expect(await requestCookie(fixture.page)).toBe("first=ok");
    expect(await fixture.app.evaluate((_e, p) => globalThis.cookieFixture.network(p).wire, next)).toEqual([]);
    return result;
  });
});

for (const [target, allowMarker] of [
  ["same-origin", false],
  ["cross-origin", false],
  ["cross-origin", true],
] as const) {
  test(
    "credentials omit across " + target + " redirect" + (allowMarker ? " with marker allowed by CORS" : ""),
    async ({ fixture }) => {
      const results = [];
      for (const site of ["localhost", "jar"] as const) {
        // Seed both destinations so sending a cookie to either hop is observable. Seed the remote
        // site after visiting the tested one: leaving a native site clears its data.
        await fixture.visit(site);
        await fixture.set(["local=seed; Path=/"]);
        await fixture.app.evaluate(
          ({ session }, url) =>
            session.defaultSession.cookies.set({
              url,
              name: "remote",
              value: "seed",
              path: "/",
              secure: true,
              sameSite: "no_restriction",
            }),
          fixture.origins.https,
        );
        const next = await fixture.replyPath(
          ["unexpected=second; Secure; SameSite=None; Path=/"],
          allowMarker ? "/allow-omit-preflight" : "/set",
        );
        const path = await fixture.replyPath(["unexpected=first; Path=/"], "/redirect");
        const result = await fixture.page.evaluate(
          async (url) => {
            try {
              const response = await fetch(url, { credentials: "omit" });
              return { status: response.status, text: await response.text() };
            } catch (error) {
              if (!(error instanceof Error)) throw error;
              return { error: error.name };
            }
          },
          path +
            "&status=302&next=" +
            encodeURIComponent((target === "cross-origin" ? fixture.origins.https : "") + next),
        );
        const network = await fixture.app.evaluate(
          (_e, paths) =>
            paths.map((p) => ({
              wire: globalThis.cookieFixture.network(p).wire,
              cookie: globalThis.cookieFixture.observation(p).cookie,
            })),
          [path, next],
        );
        const local = await requestCookie(fixture.page);
        await fixture.visit("https");
        results.push({ result, network, local, remote: await requestCookie(fixture.page) });
      }
      const get = { method: "GET", marker: null };
      const first = { wire: [get], cookie: "" };
      const native = {
        result: { status: 200, text: "" },
        network: [first, { wire: [get], cookie: "" }],
        local: "local=seed",
        remote: "remote=seed",
      };
      expect(results[0]).toEqual(native);
      if (target === "same-origin") {
        expect(results[1]).toEqual(native);
      } else {
        // The protocol handler strips its upstream copy. Chromium follows Location using the renderer's headers.
        const preflight = { method: "OPTIONS", marker: null, preflightHeaders: OMIT_COOKIES_HEADER };
        const wire = allowMarker ? [preflight, { method: "GET", marker: "1" }] : [preflight];
        expect(results[1]).toEqual({
          ...native,
          result: allowMarker ? native.result : { error: "TypeError" },
          network: [first, { wire, cookie: "" }],
        });
      }
    },
  );
}
