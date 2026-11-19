import { expect, test } from "./desktop.ts";

interface NavigationProbe {
  externalUrls: string[];
  redirects: { url: string; isMainFrame: boolean; prevented: boolean }[];
  dispose(): void;
}

declare global {
  var e2eNavigationProbe: NavigationProbe | undefined;
}

test("fetch and main-frame navigation follow a same-origin 302", async ({ desktop: { page } }) => {
  const redirect = "app://app/__e2e/navigation/local-redirect";
  const target = "app://app/__e2e/navigation/frame";
  const result = await page.evaluate(async (url) => {
    const response = await fetch(url);
    return { redirected: response.redirected, url: response.url, status: response.status };
  }, redirect);
  expect(result).toEqual({ redirected: true, url: target, status: 200 });

  const document = await page.goto(redirect);
  expect(document?.status()).toBe(200);
  await expect(page).toHaveURL(target);
  await expect(page.getByText("Application frame", { exact: true })).toBeVisible();
});

test("application iframes load but external redirects never open the system browser", async ({
  desktop: { app, page },
}) => {
  await app.evaluate(({ BrowserWindow, shell }) => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) throw new Error("Application window is missing");
    const original = shell.openExternal.bind(shell);
    const externalUrls: string[] = [];
    const redirects: NavigationProbe["redirects"] = [];
    shell.openExternal = async (url) => {
      externalUrls.push(url);
    };
    const record = (details: Electron.Event<Electron.WebContentsWillRedirectEventParams>) => {
      redirects.push({ url: details.url, isMainFrame: details.isMainFrame, prevented: details.defaultPrevented });
    };
    window.webContents.on("will-redirect", record);
    globalThis.e2eNavigationProbe = {
      externalUrls,
      redirects,
      dispose() {
        shell.openExternal = original;
        window.webContents.off("will-redirect", record);
      },
    };
  });
  try {
    // This fixture's CSP permits the one external target so Electron, rather than CSP, blocks it.
    await page.goto("app://app/__e2e/navigation/page");
    await expect(page.frameLocator("#navigation-fixture").getByText("Application frame")).toBeVisible();
    expect(
      await page
        .frameLocator("#navigation-fixture")
        .locator("html")
        .evaluate(() => typeof window.desktop),
    ).toBe("undefined");
    await page.locator("#navigation-fixture").evaluate((frame) => {
      if (frame instanceof HTMLIFrameElement) frame.src = "/__e2e/navigation/redirect";
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.e2eNavigationProbe?.redirects))
      .toContainEqual({ url: "https://example.test/e2e-redirect", isMainFrame: false, prevented: true });
    expect(await app.evaluate(() => globalThis.e2eNavigationProbe?.externalUrls)).toEqual([]);
    await expect(page).toHaveURL("app://app/__e2e/navigation/page");
  } finally {
    await app.evaluate(() => {
      globalThis.e2eNavigationProbe?.dispose();
      globalThis.e2eNavigationProbe = undefined;
    });
  }
});

test("internal popup shares the application session and survives its opener", async ({ desktop: { app, page } }) => {
  const popup = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?child=1", "_blank");
  });
  const child = await popup;
  await expect(child).toHaveURL("app://app/?child=1");
  for (const current of [child, page]) {
    expect(await current.evaluate(() => window.desktop!.setPref("windowProbe", "active"))).toEqual({
      status: "applied",
    });
  }
  expect(
    await app.evaluate(
      ({ app: electronApp }) => electronApp.getAppMetrics().filter((metric) => metric.name === "web-server").length,
    ),
  ).toBe(1);
  expect(
    await app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      return windows.length === 2 && windows[0]?.webContents.session === windows[1]?.webContents.session;
    }),
  ).toBe(true);
  await page.close();
  await child.reload();
  await expect(child).toHaveURL("app://app/?child=1");
});

test("an ordinary target=_blank link opens its route in a separate window", async ({ desktop: { app, page } }) => {
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/?from=link#section";
    link.target = "_blank";
    link.textContent = "Open child route";
    document.body.prepend(link);
  });
  const popup = app.waitForEvent("window");
  await page.getByText("Open child route", { exact: true }).click();
  const child = await popup;
  await expect(child).toHaveURL("app://app/?from=link#section");
  await child.close();
  await expect(page).toHaveURL("app://app/");
  expect(await page.evaluate(() => window.desktop!.setPref("afterClose", "ok"))).toEqual({ status: "applied" });
});
