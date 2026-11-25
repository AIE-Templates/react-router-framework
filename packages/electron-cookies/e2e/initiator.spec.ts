import { expect, requestCookie, test } from "./fixture.ts";

test("SRV-09 | cookies follow Chromium's initiator for main loads, the app and its workers", async ({ fixture }) => {
  const { app, page } = fixture;
  await fixture.set(["sid=trusted; Path=/; Secure; SameSite=None"]);
  const path = await fixture.replyPath(["main=ok; Path=/"]);
  await app.evaluate(
    async ({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].loadURL(url),
    fixture.origins.jar + path,
  );
  const initial = await app.evaluate((_electron, p) => globalThis.cookieFixture.observation(p), path);
  expect(initial.reached).toBe(true);
  expect(initial.initiator).toBeUndefined();
  expect(initial.cookie).toBe("sid=trusted");
  await fixture.visit("jar");
  const echo = await requestCookie(page);
  expect(echo.split("; ").toSorted()).toEqual(["main=ok", "sid=trusted"]);
  for (const kind of ["dedicated", "shared"]) {
    const workerEcho = await fixture.replyPath(["sid=trusted; Secure; SameSite=None; Path=/"]);
    const result = await page.evaluate(
      ({ workerType, script }) =>
        new Promise<unknown>((resolve, reject) => {
          const worker =
            workerType === "shared"
              ? new SharedWorker(script, { type: "module" })
              : new Worker(script, { type: "module" });
          const received = (event: MessageEvent<unknown>) => {
            if (worker instanceof SharedWorker) worker.port.close();
            else worker.terminate();
            resolve(event.data);
          };
          if (worker instanceof SharedWorker) {
            worker.port.addEventListener("message", received, { once: true });
            worker.port.start();
          } else {
            worker.addEventListener("message", received, { once: true });
          }
          worker.addEventListener("error", () => reject(new Error("Failed to load " + workerType + " worker")), {
            once: true,
          });
        }),
      { workerType: kind, script: "/worker.js?echo=" + encodeURIComponent(workerEcho) },
    );
    expect(result, kind).toEqual([200, echo]);
    expect(await app.evaluate((_module, p) => globalThis.cookieFixture.observation(p), workerEcho)).toEqual({
      reached: true,
      initiator: fixture.origins.jar,
      cookie: echo,
    });
  }
});

test("SRV-09 | an opaque srcdoc frame sends no cookies and cannot write through its response", async ({ fixture }) => {
  const { page, app } = fixture;
  await fixture.set(["sid=trusted; Path=/; Secure; SameSite=None"]);
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.sandbox.add("allow-scripts");
    frame.srcdoc = "<!doctype html><title>Opaque cookie fixture</title><body id=opaque></body>";
    document.body.append(frame);
  });
  const path = await fixture.replyPath(["sid=opaque; Path=/; Secure; SameSite=None", "extra=bad; Path=/"]);
  const frame = page.frameLocator("iframe").locator("#opaque");
  const origin = await frame.evaluate(async (_body, url) => {
    await fetch(url, { mode: "no-cors", credentials: "include" });
    return self.origin;
  }, fixture.origins.jar + path);
  expect(origin).toBe("null");
  expect(await app.evaluate((_electron, p) => globalThis.cookieFixture.observation(p), path)).toEqual({
    reached: true,
    initiator: "null",
    cookie: "",
  });
  expect(await requestCookie(page)).toBe("sid=trusted");
  expect((await fixture.stored("jar")).map((c) => c.value)).toEqual(["trusted"]);
});

test("SRV-09 | other custom and native origins cannot read or replace jar cookies", async ({ fixture }) => {
  await fixture.set(["sid=trusted; Secure; SameSite=None; Path=/"]);
  const other = await fixture.app.evaluate(() => globalThis.cookieFixture.otherOrigin);
  for (const origin of [other, fixture.origins.https]) {
    await fixture.page.goto(origin + "/");
    const path = await fixture.replyPath(["sid=foreign; Secure; SameSite=None; Path=/"]);
    await fixture.page.evaluate(async (url) => {
      await fetch(url, { mode: "no-cors", credentials: "include" });
    }, fixture.origins.jar + path);
    expect(await fixture.app.evaluate((_electron, p) => globalThis.cookieFixture.observation(p), path)).toEqual({
      reached: true,
      initiator: origin,
      cookie: "",
    });
    expect((await fixture.stored("jar")).map((c) => c.value)).toEqual(["trusted"]);
  }
  await fixture.visit("jar");
  expect(await requestCookie(fixture.page)).toBe("sid=trusted");
});
