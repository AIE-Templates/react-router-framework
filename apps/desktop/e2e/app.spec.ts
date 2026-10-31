import { expect, test, waitForApp } from "./desktop.ts";

// What a driver adds over the in-app smoke (DESKTOP_SMOKE=1): real input events, reloads and
// navigations made from outside the page, and the window as the main process sees it.

test("the home page loads over app:// as the hydrated desktop document", async ({ desktop: { page } }) => {
  expect(page.url()).toBe("app://app/");
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-shell", "desktop");
  await expect(html).toHaveAttribute("data-platform", process.platform);
  await expect(html).toHaveAttribute("data-hydrated", "true");
  await expect(page.getByRole("heading", { name: "One application, three layout layers" })).toBeVisible();
  await expect(page.getByText("Host: desktop.")).toBeVisible();
});

test("real input drives client-side navigation and React state", async ({ desktop: { page } }) => {
  await page.getByRole("combobox", { name: "App shell" }).selectOption("basic");
  await expect(page).toHaveURL("app://app/?shell=basic");
  const draft = page.getByRole("textbox", { name: "Module draft" });
  await draft.fill("typed by Playwright");
  await expect(draft).toHaveValue("typed by Playwright");
  // The select is controlled by the URL: going back restores it without a document load.
  await page.goBack();
  await expect(page).toHaveURL("app://app/");
  await expect(page.getByRole("combobox", { name: "App shell" })).toHaveValue("navigation");
});

test("a reload serves and hydrates the document again", async ({ desktop: { page } }) => {
  await page.getByRole("combobox", { name: "Title bar" }).selectOption("standalone");
  await expect(page).toHaveURL("app://app/?header=standalone");
  await page.evaluate(() => Reflect.set(window, "e2eBeforeReload", true));
  await page.reload();
  await waitForApp(page);
  expect(await page.evaluate(() => Reflect.get(window, "e2eBeforeReload"))).toBeUndefined();
  await expect(page.getByRole("combobox", { name: "Title bar" })).toHaveValue("standalone");
  // The preload bridge is recreated with the new document.
  expect(await page.evaluate(() => typeof window.desktop?.subscribeWindowState)).toBe("function");
});

test("an unknown path renders the 404 page, and the app recovers from it", async ({ desktop: { page } }) => {
  const response = await page.goto("app://app/no-such-page");
  expect(response?.status()).toBe(process.env.SSR === "false" ? 200 : 404);
  await waitForApp(page);
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await page.goto("app://app/");
  await waitForApp(page);
  await expect(page.getByRole("heading", { name: "One application, three layout layers" })).toBeVisible();
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

test("Home preserves the document, draft and existing query settings", async ({ desktop: { page } }) => {
  await page.getByRole("combobox", { name: "Title bar" }).selectOption("standalone");
  await page.getByRole("textbox", { name: "Module draft" }).fill("keep this draft");
  await page.evaluate(() => Reflect.set(window, "layoutDocument", true));
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(page).toHaveURL("app://app/?header=standalone&shell=navigation");
  await expect(page.getByRole("textbox", { name: "Module draft" })).toHaveValue("keep this draft");
  expect(await page.evaluate(() => Reflect.get(window, "layoutDocument"))).toBe(true);
  await expect(page.getByRole("main")).toHaveCount(1);
});

test("container scrolling resets on navigation and restores on back and forward", async ({ desktop: { page } }) => {
  // SPA document hydration can finish before the initial route module resolves.
  await expect(page.locator('[data-scroll-restoration-id="welcome:workspace"]')).toBeVisible();
  // Make both actual CSS scroll containers overflow without adding test-only application routes.
  await page.evaluate(async () => {
    const root = document.querySelector<HTMLElement>(".root-content")!;
    const workspace = document.querySelector<HTMLElement>('[data-scroll-restoration-id="welcome:workspace"]')!;
    for (const element of [root, workspace]) {
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      element.append(spacer);
    }
    root.scrollTop = 120;
    workspace.scrollTop = 240;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const root = page.locator(".root-content");
  const workspace = page.locator('[data-scroll-restoration-id="welcome:workspace"]');
  await expect(root).toHaveJSProperty("scrollTop", 120);
  await expect(workspace).toHaveJSProperty("scrollTop", 240);
  // Avoid Playwright scrolling Home into view before the click and changing the position under test.
  await page.getByRole("link", { name: "Home", exact: true }).evaluate((element) => {
    if (element instanceof HTMLElement) element.click();
  });
  await expect(page).toHaveURL("app://app/?shell=navigation");
  await expect(root).toHaveJSProperty("scrollTop", 0);
  await expect(workspace).toHaveJSProperty("scrollTop", 0);
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>(".root-content")!.scrollTop = 80;
    document.querySelector<HTMLElement>('[data-scroll-restoration-id="welcome:workspace"]')!.scrollTop = 60;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  await page.goBack();
  await expect(root).toHaveJSProperty("scrollTop", 120);
  await expect(workspace).toHaveJSProperty("scrollTop", 240);
  await page.goForward();
  await expect(root).toHaveJSProperty("scrollTop", 80);
  await expect(workspace).toHaveJSProperty("scrollTop", 60);
});
