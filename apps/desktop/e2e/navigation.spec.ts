import { expect, test } from "./desktop.ts";

interface NavigationProbe {
  externalUrls: string[];
  redirects: { url: string; isMainFrame: boolean; prevented: boolean }[];
  dispose(): void;
}

declare global {
  var e2eNavigationProbe: NavigationProbe | undefined;
}

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
