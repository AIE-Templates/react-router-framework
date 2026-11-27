import type { Page } from "@playwright/test";
import { cookieName, storageKey, visualRecordKernel } from "@repo/shared";

import { expect, quit, targetProcesses, test, waitForApp, type Launched } from "./desktop.ts";
import { firstVisualSeed, pushVisual, isSsrBuild } from "./visual-mirror.ts";

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
    await page.evaluate(() => {
      window.open("https://example.test/external");
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.e2eNavigationProbe?.externalUrls))
      .toEqual(["https://example.test/external"]);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
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

test("a child starts with the committed theme despite stale storage and honors explicit geometry", async ({
  desktop: { app, page },
}) => {
  const initial = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
  );
  const preference = initial === "#17191d" ? "light" : "dark";
  const stale = preference === "dark" ? "light" : "dark";
  const raw = await pushVisual(page, { colorScheme: preference, direction: "rtl" });
  const staleRaw = visualRecordKernel.encode({
    version: 1,
    stamp: { t: 0, id: "stale" },
    preferences: { colorScheme: stale },
  });
  await page.evaluate(([key, wire]) => localStorage.setItem(key, wire), [
    storageKey("visual-preferences"),
    staleRaw,
  ] as const);
  const created = app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<{ color: string; x?: number; width?: number }>((resolve) => {
        BrowserWindow.getAllWindows()[0].webContents.once("did-create-window", (child, { options }) => {
          resolve({ color: child.getBackgroundColor().toLowerCase(), x: options.x, width: options.width });
        });
      }),
  );
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?sized", "_blank", "left=80,width=650");
  });
  const child = await opened;
  expect(await created).toEqual({ color: preference === "dark" ? "#17191d" : "#ffffff", x: 80, width: 650 });
  await waitForApp(child);
  expect(await child.evaluate(() => window.desktop!.visualSeed)).toEqual({ record: raw, pending: false });
  expect(await child.evaluate(() => Reflect.get(window, "frameworkVisualBootstrap")?.state.preferences)).toMatchObject({
    colorScheme: preference,
    direction: "rtl",
  });
  await expect(child.locator("html")).toHaveAttribute("data-color-scheme", preference);
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", preference);
});

async function expectVisualCookie(page: Page, raw: string | null) {
  const actual = await page.evaluate(
    (name) => document.cookie.split(/;\s*/).find((entry) => entry.startsWith(name + "=")),
    cookieName("visual"),
  );
  expect(actual).toBe(raw === null ? undefined : cookieName("visual") + "=" + encodeURIComponent(raw));
}

const visualKey = storageKey("visual-preferences");

async function expectWebReplicas(page: Page, raw: string | null, ssr: boolean) {
  expect(await page.evaluate((key) => localStorage.getItem(key), visualKey)).toBe(raw);
  await expectVisualCookie(page, ssr ? raw : null);
}

async function expectRestoredTheme({ app, page }: Launched, raw: string, ssr: boolean) {
  expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
  expect(await page.evaluate(() => window.desktop!.visualSeed)).toEqual({ record: raw, pending: false });
  expect(await firstVisualSeed(page)).toEqual(ssr ? visualRecordKernel.decode(raw).record : undefined);
  await expectWebReplicas(page, raw, ssr);
  expect(await page.evaluate(() => Reflect.get(window, "frameworkVisualBootstrap"))).toMatchObject({
    record: visualRecordKernel.decode(raw).record,
    state: { resolved: { colorScheme: "dark", direction: "rtl" } },
  });
  await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

test("a full relaunch restores the committed desktop theme before hydration", async ({ launchApp }) => {
  const first = await launchApp();
  const ssr = await isSsrBuild(first.page);
  await expectWebReplicas(first.page, null, ssr);
  expect(await first.page.evaluate(() => window.desktop!.readVisual())).toEqual({ record: null, pending: false });
  const raw = await pushVisual(first.page, { colorScheme: "dark", direction: "rtl" });
  await first.page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expectWebReplicas(first.page, raw, ssr);

  // Retire the manager before clearing its replicas. An active document could repair them.
  await first.page.goto("app://app/__e2e/navigation/frame");
  await first.app.evaluate(({ session }) =>
    session.fromPartition("persist:app").clearStorageData({ storages: ["localstorage", "cookies"] }),
  );
  await expectWebReplicas(first.page, null, ssr);
  await quit(first);
  await expectRestoredTheme(await launchApp(), raw, ssr);
});

test("a crash with stale Web replicas restores the newer native record before hydration", async ({
  launchApp,
  target,
}) => {
  const first = await launchApp();
  const ssr = await isSsrBuild(first.page);
  const old = await pushVisual(first.page, { colorScheme: "light", direction: "ltr" });
  await first.page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await expectWebReplicas(first.page, old, ssr);
  // A clean shutdown makes the older Chromium copies durable.
  await quit(first);

  const writer = await launchApp();
  await writer.page.goto("app://app/__e2e/navigation/frame");
  // This document has no VisualManager. Advance only N to model loss of the latest Chromium writes.
  const raw = await pushVisual(writer.page, { colorScheme: "dark", direction: "rtl" });
  await expectWebReplicas(writer.page, old, ssr);
  if (ssr) {
    const scheme = await writer.page.evaluate(async () => {
      const html = await (await fetch("/", { headers: { Accept: "text/html" } })).text();
      return new DOMParser().parseFromString(html, "text/html").documentElement.dataset.colorScheme;
    });
    expect(scheme).toBe("light");
  }
  process.kill(writer.pid, "SIGKILL");
  await expect.poll(() => targetProcesses(target), { timeout: 10000 }).toEqual([]);
  await expectRestoredTheme(await launchApp(), raw, ssr);
});

test("a window overlay inherits app theme changes and releases to the latest defaults", async ({
  desktop: { app, page },
}) => {
  await pushVisual(page, { colorScheme: "light" });
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/__e2e/navigation/frame", "_blank", "noopener");
  });
  const peer = await opened;
  await peer.waitForURL("app://app/__e2e/navigation/frame");
  const native = await app.browserWindow(peer);
  const overridesSupported =
    process.platform !== "darwin" && (await peer.evaluate(() => window.desktop!.bootstrap?.mode === "native-overlay"));
  const overlayProbe = overridesSupported
    ? await native.evaluateHandle((win) => {
        const writes: Electron.TitleBarOverlayOptions[] = [];
        const original = win.setTitleBarOverlay.bind(win);
        win.setTitleBarOverlay = (value: Electron.TitleBarOverlayOptions) => {
          writes.push({ ...value });
          return original(value);
        };
        return {
          writes,
          restore: () => {
            win.setTitleBarOverlay = original;
          },
        };
      })
    : undefined;
  try {
    const declaration = await peer.evaluate(() =>
      window.desktop!.declareOverlayAppearance({
        owner: "layout-probe",
        revision: 1,
        appearance: { color: "#224466" },
      }),
    );
    if (overridesSupported)
      expect(declaration).toMatchObject({
        status: "applied",
        appearance: { color: "#224466", symbolColor: "#202124" },
      });
    else expect(declaration.status).toBe("unsupported");

    await pushVisual(page, { colorScheme: "dark" });
    await expect.poll(() => native.evaluate((win) => win.getBackgroundColor().toLowerCase())).toBe("#17191d");
    if (overlayProbe) {
      expect(await overlayProbe.evaluate((probe) => probe.writes.at(-1))).toMatchObject({
        color: "#224466",
        symbolColor: "#f3f4f6",
      });
    }
    const release = await peer.evaluate(() =>
      window.desktop!.declareOverlayAppearance({ owner: "layout-probe", revision: 2, appearance: null }),
    );
    if (overridesSupported)
      expect(release).toMatchObject({ status: "applied", appearance: { color: "#17191d", symbolColor: "#f3f4f6" } });
    else expect(release.status).toBe("unsupported");
  } finally {
    await overlayProbe?.evaluate((probe) => probe.restore());
    await overlayProbe?.dispose();
  }
});

test("ten sibling popups stagger on the display and share one system theme listener", async ({
  desktop: { app, page },
}) => {
  const parent = await app.browserWindow(page);
  const parentId = await parent.evaluate((win) => win.id);
  const listeners = () => app.evaluate(({ nativeTheme }) => nativeTheme.listenerCount("updated"));
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const initial = await listeners();
  // A small app document that can share the opener's renderer keeps the eleven-window case inexpensive.
  await page.evaluate(() => {
    for (let i = 0; i < 10; i++) window.open("/__e2e/navigation/frame?sibling=" + i, "_blank");
  });
  await expect.poll(windowCount).toBe(11);
  expect(await listeners()).toBe(initial);
  // Wayland compositors own absolute placement. Other desktops expose the native coordinates.
  if (process.platform !== "linux" || process.env.XDG_SESSION_TYPE !== "wayland") {
    const [first, second] = await app.evaluate(
      ({ BrowserWindow }, id) =>
        BrowserWindow.getAllWindows()
          .filter((win) => win.id !== id)
          .toSorted((a, b) => a.id - b.id)
          .slice(0, 2)
          .map((win) => win.getBounds()),
      parentId,
    );
    expect([first.x, first.y]).not.toEqual([second.x, second.y]);
  }
  await app.evaluate(({ BrowserWindow }, id) => {
    for (const win of BrowserWindow.getAllWindows()) if (win.id !== id) win.close();
  }, parentId);
  await expect.poll(windowCount).toBe(1);
  expect(await listeners()).toBe(initial);
});

test("a fullscreen child receives its own SSR window state on reload", async ({ desktop: { app, page } }) => {
  test.skip(!(await isSsrBuild(page)), "SPA documents are static and carry no per-window state");
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?fullscreen", "_blank", "noopener");
  });
  const peer = await opened;
  await waitForApp(peer);
  await app.evaluate(
    ({ BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("?fullscreen"))!;
        win.once("enter-full-screen", () => resolve());
        win.setFullScreen(true);
      }),
  );
  const html = await (await peer.reload())!.text();
  expect(html).toContain('data-fullscreen="true"');
  expect(await (await page.reload())!.text()).toContain('data-fullscreen="false"');
});

test("a replaced utility serves all windows without discarding live documents", async ({ desktop: { app, page } }) => {
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?peer", "_blank", "noopener");
  });
  const peer = await opened;
  await waitForApp(peer);
  for (const document of [page, peer]) await document.evaluate(() => Reflect.set(window, "recoveryDraft", "unsaved"));
  const pid = await app.evaluate(({ app: host }) => {
    const previous = host.getAppMetrics().find((metric) => metric.name === "web-server")!.pid;
    process.kill(previous, "SIGKILL");
    return previous;
  });
  const later = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?during-restart", "_blank", "noopener");
  });
  const duringRestart = await later;
  await waitForApp(duringRestart);
  await expect(duringRestart).toHaveURL("app://app/?during-restart");
  await expect
    .poll(() =>
      app.evaluate(
        ({ app: host }, previous) =>
          host.getAppMetrics().some((metric) => metric.name === "web-server" && metric.pid !== previous),
        pid,
      ),
    )
    .toBe(true);
  for (const document of [page, peer]) {
    await expect.poll(() => document.evaluate(async () => (await fetch("/api/health")).ok)).toBe(true);
    expect(await document.evaluate(() => Reflect.get(window, "recoveryDraft"))).toBe("unsaved");
  }
});

test("a window can cancel quit, keep using the server and then quit normally", async ({ desktop }) => {
  const { app, page } = desktop;
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?draft", "_blank", "noopener");
  });
  const peer = await opened;
  await waitForApp(peer);
  await peer.evaluate(() => Reflect.set(window, "recoveryDraft", "unsaved"));
  await app.evaluate(
    ({ app: host, BrowserWindow }) =>
      new Promise<void>((resolve) => {
        const draft = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().endsWith("?draft"))!;
        draft.once("close", (event) => {
          event.preventDefault();
          resolve();
        });
        host.quit();
      }),
  );
  expect(await peer.evaluate(() => Reflect.get(window, "recoveryDraft"))).toBe("unsaved");
  expect(await peer.evaluate(async () => (await fetch("/api/health")).status)).toBe(200);
  expect(await peer.evaluate(() => window.desktop!.setPref("quitDraft", "saved"))).toEqual({ status: "applied" });
  await quit(desktop);
});

for (const decision of ["reload", "cancel"] as const) {
  test(`renderer recovery honors ${decision} for affected documents and preserves unrelated windows`, async ({
    desktop: { page, app },
  }) => {
    const shared = app.waitForEvent("window");
    await page.evaluate(() => {
      window.open("/?opener");
    });
    const child = await shared;
    await waitForApp(child);
    expect(await child.evaluate(() => window.opener?.location.href)).toBe("app://app/");
    const independent = app.waitForEvent("window");
    await page.evaluate(() => {
      window.open("/?independent", "_blank", "noopener");
    });
    const other = await independent;
    await waitForApp(other);
    await other.evaluate(() => Reflect.set(window, "unrelatedDraft", "leave intact"));
    const recovered = app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const target = windows.find((win) => win.webContents.getURL().includes("?opener"))!;
      const pid = target.webContents.getOSProcessId();
      const affected = windows.filter((win) => win.webContents.getOSProcessId() === pid);
      const loads = affected.map(
        (win) => new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve())),
      );
      target.webContents.forcefullyCrashRenderer();
      return Promise.all(loads);
    });
    await recovered;
    // Playwright retains the crashed page targets. Inspect the replacement renderers through main.
    await expect
      .poll(() =>
        app.evaluate(async ({ BrowserWindow }) => {
          return Promise.all(
            BrowserWindow.getAllWindows().map(async (win) => {
              const hydrated: unknown = await win.webContents.executeJavaScript(
                "document.documentElement.dataset.hydrated",
              );
              return hydrated === "true" ? win.webContents.getURL() : "";
            }),
          );
        }),
      )
      .toEqual(expect.arrayContaining(["app://app/", "app://app/?opener", "app://app/?independent"]));
    // The first crash consumed the automatic retry. The second needs a user decision.
    const decisions = await app.evaluate(async ({ BrowserWindow, dialog }, answerKind) => {
      const windows = BrowserWindow.getAllWindows();
      const target = windows.find((win) => win.webContents.getURL().includes("?opener"))!;
      const affected = windows.filter(
        (win) => win.webContents.getOSProcessId() === target.webContents.getOSProcessId(),
      );
      const original = dialog.showMessageBox.bind(dialog);
      const answers: (() => void)[] = [];
      const buttons: string[][] = [];
      const cancelLabels: (string | undefined)[] = [];
      dialog.showMessageBox = (
        first: Electron.BaseWindow | Electron.MessageBoxOptions,
        second?: Electron.MessageBoxOptions,
      ) =>
        new Promise((resolve) => {
          const options = second ?? first;
          if (!("buttons" in options)) throw new Error("Missing recovery buttons");
          buttons.push(options.buttons ?? []);
          const cancelId = options.cancelId ?? 0;
          cancelLabels.push(options.buttons?.[cancelId]);
          answers.push(() => resolve({ response: answerKind === "cancel" ? cancelId : 0, checkboxChecked: false }));
        });
      try {
        const gone = affected.map(
          (win) => new Promise<void>((resolve) => win.webContents.once("render-process-gone", () => resolve())),
        );
        const loaded =
          answerKind === "cancel"
            ? []
            : affected.map(
                (win) => new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve())),
              );
        target.webContents.forcefullyCrashRenderer();
        await Promise.all(gone);
        await new Promise<void>((resolve) => setImmediate(resolve));
        for (const answer of answers) answer();
        await Promise.all(loaded);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          buttons,
          cancelLabels,
          shared: affected.length > 1,
          keptFailedDocuments: affected.every((win) => !win.isDestroyed() && win.webContents.isCrashed()),
        };
      } finally {
        dialog.showMessageBox = original;
      }
    }, decision);
    expect(decisions.keptFailedDocuments).toBe(decision === "cancel");
    expect(decisions.cancelLabels).toEqual(["Cancel"]);
    expect(decisions.buttons).toEqual(
      decisions.shared
        ? [["Reload affected windows", "Close affected windows", "Cancel"]]
        : [["Reload", "Close", "Cancel"]],
    );
    expect(await other.evaluate(() => Reflect.get(window, "unrelatedDraft"))).toBe("leave intact");
  });
}

test("a recovered owner releases the native sheet while an affected peer keeps its choice", async ({
  desktop: { app, page },
}) => {
  const opened = app.waitForEvent("window");
  await page.evaluate(() => {
    window.open("/?peer");
  });
  await waitForApp(await opened);
  const result = await app.evaluate(async ({ BrowserWindow, dialog }) => {
    const [first, peer] = BrowserWindow.getAllWindows();
    const shared = first.webContents.getOSProcessId() === peer.webContents.getOSProcessId();
    const original = dialog.showMessageBox.bind(dialog);
    const sheets: { owner: Electron.BaseWindow; signal: AbortSignal }[] = [];
    dialog.showMessageBox = (
      owner: Electron.BaseWindow | Electron.MessageBoxOptions,
      options?: Electron.MessageBoxOptions,
    ) =>
      new Promise((resolve) => {
        if (!(owner instanceof BrowserWindow) || !options?.signal)
          throw new Error("Expected a cancellable window sheet");
        sheets.push({ owner, signal: options.signal });
        options.signal.addEventListener(
          "abort",
          () => resolve({ response: options.cancelId!, checkboxChecked: false }),
          { once: true },
        );
      });
    try {
      first.emit("unresponsive");
      peer.emit("unresponsive");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const initial = sheets.length;
      first.emit("responsive");
      await new Promise<void>((resolve) => setImmediate(resolve));
      const remaining = sheets.filter((sheet) => !sheet.signal.aborted);
      peer.emit("responsive");
      await new Promise<void>((resolve) => setImmediate(resolve));
      return {
        shared,
        initial,
        peerOnly: remaining.length === 1 && remaining[0].owner === peer,
        allRetired: sheets.every((sheet) => sheet.signal.aborted),
      };
    } finally {
      dialog.showMessageBox = original;
    }
  });
  expect(result.initial).toBe(result.shared ? 1 : 2);
  expect(result.peerOnly).toBe(true);
  expect(result.allRetired).toBe(true);
});
