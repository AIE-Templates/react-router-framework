import { compareNative, expect, requestCookie, test } from "./fixture.ts";

test("SRV | Set-Cookie on 204, 401 and 500 is stored before fetch resolves", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    const results = [];
    for (const status of [204, 401, 500]) {
      const path = await fixture.replyPath(["status=" + status + "; Path=/"]);
      const result = await fixture.page.evaluate(
        async (url) => {
          const response = await fetch(url);
          return [response.status, response.headers.get("set-cookie"), document.cookie];
        },
        path + "&status=" + status,
      );
      expect(result).toEqual([status, null, "status=" + status]);
      results.push(result);
    }
    return results;
  });
});

for (const kind of ["FormData", "Blob", "ReadableStream", "keepalive"] as const) {
  test("SRV | POST with " + kind + " preserves body, credentials and response cookies", async ({ fixture }) => {
    const observe = async () => {
      await fixture.set(["sent=one; Path=/"]);
      const path = await fixture.replyPath(["stored=two; Path=/"], "/inspect");
      const result = await fixture.page.evaluate(
        async ({ path: target, kind: input }) => {
          const init: RequestInit & { duplex?: "half" } = { method: "POST" };
          if (input === "FormData") {
            const fields = new FormData();
            fields.append("key", "one");
            fields.append("key", "two");
            init.body = fields;
          } else if (input === "Blob") {
            init.body = new Blob(["one", "two"], { type: "application/octet-stream" });
          } else if (input === "ReadableStream") {
            init.duplex = "half";
            init.body = new ReadableStream({
              start(controller) {
                for (const chunk of ["one", "two"]) controller.enqueue(new TextEncoder().encode(chunk));
                controller.close();
              },
            });
          } else {
            init.body = "onetwo";
            init.keepalive = true;
          }
          try {
            const response = await fetch(target, init);
            return { status: response.status, report: (await response.json()) as unknown };
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            return { error: error.name };
          }
        },
        { path, kind },
      );
      const reads = await fixture.app.evaluate((_e, p) => globalThis.cookieFixture.network(p).wire, path);
      const cookie = await requestCookie(fixture.page);
      if (!("error" in result)) {
        expect(result).toMatchObject({
          status: 200,
          report: {
            method: "POST",
            cookie: "sent=one",
            body:
              kind === "FormData"
                ? [
                    ["key", "one"],
                    ["key", "two"],
                  ]
                : "onetwo",
          },
        });
        expect(cookie).toBe("sent=one; stored=two");
      }
      return { result, reads, cookie };
    };
    if (kind === "ReadableStream") {
      const origin = await fixture.app.evaluate(() => globalThis.cookieFixture.openHttp2Origin());
      await fixture.page.goto(origin + "/");
      const native = await observe();
      await fixture.visit("jar");
      const jar = await observe();
      expect(native.result).toMatchObject({ status: 200, report: { body: "onetwo" } });
      expect(jar).toEqual(native);
    } else {
      await compareNative(fixture, "/", async () => {
        const observed = await observe();
        expect(observed.result).toMatchObject({ status: 200 });
        return observed;
      });
    }
  });
}

test("SRV | XMLHttpRequest sends and stores cookies while hiding Set-Cookie", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    await fixture.set(["sent=one; Path=/"]);
    const path = await fixture.replyPath(["stored=two; Path=/"]);
    const result = await fixture.page.evaluate(
      (url) =>
        new Promise<unknown>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("GET", url);
          xhr.addEventListener("load", () =>
            resolve([xhr.status, xhr.responseText, xhr.getResponseHeader("set-cookie"), document.cookie]),
          );
          xhr.addEventListener("error", () => reject(new Error("XHR failed")));
          xhr.send();
        }),
      path,
    );
    expect(result).toEqual([200, "sent=one", null, "sent=one; stored=two"]);
    return result;
  });
});

test("SRV | image, script and EventSource requests send and store cookies", async ({ fixture }) => {
  await compareNative(fixture, "/", async () => {
    await fixture.set(["sent=one; Path=/"]);
    const results = [];
    for (const [index, route] of ["/pixel.gif", "/subresource.js", "/events"].entries()) {
      const before = await requestCookie(fixture.page);
      const path = await fixture.replyPath(["resource=" + index + "; Path=/"], route);
      await fixture.page.evaluate(
        ({ path: url, route: resource }) =>
          new Promise<void>((resolve, reject) => {
            if (resource === "/events") {
              const source = new EventSource(url);
              source.addEventListener("message", ({ data }) => {
                source.close();
                if (data === "ready") resolve();
                else reject(new Error("Unexpected event data"));
              });
              source.addEventListener("error", () => {
                source.close();
                reject(new Error("EventSource failed"));
              });
            } else {
              const element = resource === "/pixel.gif" ? new Image() : document.createElement("script");
              element.addEventListener("load", () => resolve());
              element.addEventListener("error", () => reject(new Error(resource + " failed")));
              element.src = url;
              document.body.append(element);
            }
          }),
        { path, route },
      );
      const sent = await fixture.app.evaluate((_e, p) => globalThis.cookieFixture.observation(p).cookie, path);
      expect(sent).toBe(before);
      expect(await requestCookie(fixture.page)).toBe("sent=one; resource=" + index);
      results.push(sent);
    }
    expect(await fixture.page.locator("html").getAttribute("data-script-loaded")).toBe("yes");
    return results;
  });
});
