import type { Page } from "@playwright/test";

import { expect, test, waitForApp } from "./desktop.ts";

// What a driver adds over the in-app smoke (DESKTOP_SMOKE=1): real input events, reloads and
// navigations made from outside the page, and the window as the main process sees it.

test("the home page loads over app:// as the hydrated desktop document", async ({ desktop: { page } }) => {
  expect(page.url()).toBe("app://app/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-shell", "desktop");
  await expect(html).toHaveAttribute("data-platform", process.platform);
  await expect(html).toHaveAttribute("data-hydrated", "true");
});

test("a reload serves and hydrates the document again", async ({ desktop: { page } }) => {
  await page.evaluate(() => Reflect.set(window, "e2eBeforeReload", true));
  await page.reload();
  await waitForApp(page);
  expect(await page.evaluate(() => Reflect.get(window, "e2eBeforeReload"))).toBeUndefined();
  expect(await page.evaluate(() => typeof window.desktop?.subscribeWindowState)).toBe("function");
});

function startPendingRequest(page: Page, owner: "old" | "new") {
  return page.evaluateHandle((body) => {
    const controller = new AbortController();
    const reply = fetch("/__e2e/reload/request", { method: "POST", body, signal: controller.signal })
      .then(async (response) => ({ status: response.status, body: await response.text() }))
      .catch((error: Error) => ({ error: error.name }));
    return { reply, abort: () => controller.abort() };
  }, owner);
}

function pendingState(page: Page) {
  return page.evaluate(async () => (await fetch("/__e2e/reload/pending")).json());
}

function releasePendingRequest(page: Page, owner: "old" | "new") {
  return page.evaluate(async (url) => (await fetch(url, { method: "POST" })).status, `/__e2e/reload/release/${owner}`);
}

test("a request after reload gets its own response when the old request finishes first", async ({
  desktop: { page },
}) => {
  await startPendingRequest(page, "old");
  await expect.poll(() => pendingState(page)).toEqual({ old: "waiting" });
  await page.reload();
  await waitForApp(page);
  const current = await startPendingRequest(page, "new");
  await expect.poll(() => pendingState(page)).toEqual({ old: "aborted", new: "waiting" });

  expect(await releasePendingRequest(page, "old")).toBe(204);
  await expect.poll(() => pendingState(page)).toEqual({ new: "waiting" });
  expect(await releasePendingRequest(page, "new")).toBe(204);
  expect(await current.evaluate(({ reply }) => reply)).toEqual({ status: 200, body: "new" });
});

test("cancelling one of two same-URL requests before headers aborts only its utility signal", async ({
  desktop: { page },
}) => {
  const first = await startPendingRequest(page, "old");
  const second = await startPendingRequest(page, "new");
  await expect.poll(() => pendingState(page)).toEqual({ old: "waiting", new: "waiting" });
  await first.evaluate(({ abort }) => abort());
  expect(await first.evaluate(({ reply }) => reply)).toEqual({ error: "AbortError" });
  await expect.poll(() => pendingState(page)).toEqual({ old: "aborted", new: "waiting" });
  expect(await releasePendingRequest(page, "old")).toBe(204);
  expect(await releasePendingRequest(page, "new")).toBe(204);
  expect(await second.evaluate(({ reply }) => reply)).toEqual({ status: 200, body: "new" });
});

test("an unknown path renders the 404 page, and the app recovers from it", async ({ desktop: { page } }) => {
  const response = await page.goto("app://app/no-such-page");
  expect(response?.status()).toBe(process.env.SSR === "false" ? 200 : 404);
  await waitForApp(page);
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await page.goto("app://app/");
  await waitForApp(page);
});

test("API calls from the page reach the server with a request ID", async ({ desktop: { page } }) => {
  const result = await page.evaluate(async () => {
    const health = await fetch("/api/health");
    const missing = await fetch("/api/no-such-route");
    return {
      status: health.status,
      body: (await health.json()) as unknown,
      requestId: health.headers.get("x-request-id"),
      missingStatus: missing.status,
      missingType: missing.headers.get("content-type"),
    };
  });
  expect(result).toMatchObject({ status: 200, body: { status: "ok" }, missingStatus: 404 });
  expect(result.requestId).toMatch(/^[\w-]{8,}$/);
  expect(result.missingType).toMatch(/^application\/json/);
});

test("the window is shown, confined to app://app and has the trusted bridge", async ({ desktop: { app, page } }) => {
  const win = await app.evaluate(({ BrowserWindow }) => {
    const [w] = BrowserWindow.getAllWindows();
    return { count: BrowserWindow.getAllWindows().length, visible: w?.isVisible(), url: w?.webContents.getURL() };
  });
  expect(win).toEqual({ count: 1, visible: true, url: "app://app/" });
  const bridge = await page.evaluate(async () => {
    const desktop = window.desktop!;
    let stop: (() => void) | undefined;
    const state = await new Promise((resolve) => {
      stop = desktop.subscribeWindowState(resolve);
    });
    stop?.();
    return { mode: desktop.bootstrap?.mode, platform: desktop.platform, state };
  });
  expect(bridge.platform).toBe(process.platform);
  expect(bridge.mode).toBe("native-overlay");
  expect(bridge.state).toMatchObject({ maximized: false, fullscreen: false });
  // Page-initiated windows are denied (and http(s) would go to the system browser, not tested here).
  await page.evaluate(() => window.open("app://app/?popup=1"));
  await page.waitForTimeout(200);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
