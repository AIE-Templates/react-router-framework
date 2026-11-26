import { mkdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";

import type { ElectronApplication, Page } from "@playwright/test";
import { cookieName, DESKTOP_VISUAL_IPC, storageKey, visualRecordKernel } from "@repo/shared";

import { expect, quit, targetProcesses, test, waitForApp } from "./desktop.ts";

async function choose(page: Page, label: string, value: string, option: string) {
  const control = page.getByRole("combobox", { name: label, exact: true });
  if (await control.evaluate((element) => element.tagName === "SELECT")) await control.selectOption(value);
  else {
    await control.click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
}

/** A window-specific handler takes precedence over ipcMain. Keep the application handler installed. */
async function holdNativePush(app: ElectronApplication, page: Page) {
  const native = await app.browserWindow(page);
  return native.evaluateHandle((win, channel) => {
    let acknowledge!: (result: string) => void;
    const gate = new Promise<string>((resolve) => {
      acknowledge = resolve;
    });
    let signal!: () => void;
    let arrived = new Promise<void>((resolve) => {
      signal = resolve;
    });
    win.webContents.ipc.handle(channel, () => {
      signal();
      return gate;
    });
    return {
      wait: () => arrived,
      arm: () => {
        arrived = new Promise<void>((resolve) => {
          signal = resolve;
        });
      },
      restore: () => {
        win.webContents.ipc.removeHandler(channel);
        acknowledge("failed");
      },
    };
  }, DESKTOP_VISUAL_IPC.push);
}

// These controls and layout expectations belong to the disposable demo.
test.describe("demo appearance", { tag: "@demo" }, () => {
  test("a fixed dark editor keeps its window appearance when the application theme changes", async ({
    desktop: { app, page: home },
  }) => {
    const open = async (name: string) => {
      const child = app.waitForEvent("window");
      await home.getByRole("link", { name, exact: true }).press("Enter");
      const page = await child;
      await waitForApp(page);
      return page;
    };
    const settings = await open("Settings");
    await choose(settings, "Color scheme", "light", "Light");
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
    const editor = await open("Open editor");
    expect(
      await editor.evaluate(() => Reflect.get(window, "frameworkVisualBootstrap")?.state.resolved.colorScheme),
    ).toBe("dark");
    const root = editor.locator("html");
    const textArea = editor.getByRole("textbox", { name: "Brief.md" });
    await editor.getByRole("combobox", { name: "Font size" }).selectOption("18");
    await expect(textArea).toHaveCSS("font-size", "18px");
    await editor.getByRole("combobox", { name: "Line wrapping" }).selectOption("off");
    await expect(textArea).toHaveAttribute("wrap", "off");
    await expect(root).toHaveAttribute("data-color-scheme", "dark");
    await expect(home.locator("html")).toHaveAttribute("data-color-scheme", "light");
    for (const value of ["dark", "light"] as const) {
      await choose(settings, "Color scheme", value, value === "dark" ? "Dark" : "Light");
      await expect(home.locator("html")).toHaveAttribute("data-color-scheme", value);
      await expect(root).toHaveAttribute("data-color-scheme", "dark");
    }
    await editor.reload();
    await waitForApp(editor);
    await expect(root).toHaveAttribute("data-color-scheme", "dark");
    await editor.goto("app://app/");
    await waitForApp(editor);
    await expect(root).toHaveAttribute("data-color-scheme", "dark");
    await editor.close();
    await expect(home.locator("html")).toHaveAttribute("data-color-scheme", "light");
  });

  test("settings update Home and Chat while all three windows keep their state", async ({
    desktop: { app, page: home },
  }) => {
    const openFromHome = async (name: string) => {
      await home.bringToFront();
      const link = home.getByRole("link", { name, exact: true });
      await expect(link).toHaveAttribute("target", "_blank");
      const [page] = await Promise.all([app.waitForEvent("window"), link.press("Enter")]);
      await waitForApp(page);
      expect(await page.evaluate(() => window.opener === null)).toBe(true);
      return page;
    };
    const note = home.getByRole("textbox", { name: "Follow-up note" });
    await note.fill("Home draft");
    await home.getByRole("combobox", { name: "Title bar" }).selectOption("standalone");
    await expect(home).toHaveURL("app://app/?header=standalone");
    await expect(home.locator(".app-shell")).toHaveAttribute("data-header-mode", "standalone");
    const chat = await openFromHome("Chat demo");
    await expect(chat).toHaveURL("app://app/chat");
    await chat.bringToFront();
    const message = chat.getByRole("textbox", { name: "Message" });
    await message.fill("Review the new settings");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    const sent = chat.getByRole("log").getByText("Review the new settings", { exact: true });
    await expect(sent).toBeVisible();
    await message.fill("Unsent chat draft");

    const settings = await openFromHome("Settings");
    await expect(settings).toHaveURL("app://app/settings");
    await expect(home).toHaveURL("app://app/?header=standalone");
    expect(app.windows()).toHaveLength(3);
    await settings.bringToFront();
    await choose(settings, "Color scheme", "dark", "Dark");
    await choose(home, "Direction", "rtl", "RTL");
    await choose(settings, "Motion", "reduce", "Reduced");
    for (const page of [settings, home, chat]) {
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    }
    const ssr = await chat.evaluate(async () => {
      const response = await fetch("/", { headers: { Accept: "text/html" } });
      const html = new DOMParser().parseFromString(await response.text(), "text/html").documentElement;
      return [html.dataset.colorScheme, html.dir, html.dataset.reducedMotion];
    });
    expect(ssr).toEqual(["dark", "rtl", "reduce"]);
    await expect(home.locator(".app-shell")).toHaveAttribute("data-header-mode", "standalone");
    await expect(chat.locator(".app-shell")).toHaveAttribute("data-header-mode", "fused");
    await settings.close();
    await expect(note).toHaveValue("Home draft");
    await expect(sent).toBeVisible();
    await expect(message).toHaveValue("Unsent chat draft");
  });

  test("reuses the settings window across openers and creates a fresh one after close", async ({
    desktop: { app, page: home },
  }) => {
    const chatOpened = app.waitForEvent("window");
    await home.getByRole("link", { name: "Chat demo" }).click();
    const chat = await chatOpened;
    await waitForApp(chat);

    const settingsOpened = app.waitForEvent("window");
    await Promise.all(
      [home, chat].map((page) =>
        page.evaluate(() => {
          window.open("/settings", "_blank", "noopener");
        }),
      ),
    );
    const settings = await settingsOpened;
    await waitForApp(settings);
    const native = await app.browserWindow(settings);
    const originalId = await native.evaluate((win) => win.id);
    const documentStart = await settings.evaluate(() => performance.timeOrigin);
    const windowIds = () =>
      app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((win) => new URL(win.webContents.getURL() || "about:blank").pathname === "/settings")
          .map((win) => win.id),
      );
    expect(await windowIds()).toEqual([originalId]);

    await native.evaluate((win) => win.hide());
    await home.bringToFront();
    await home.getByRole("link", { name: "Settings", exact: true }).click();
    await expect.poll(() => native.evaluate((win) => win.isVisible())).toBe(true);
    await chat.evaluate(() => {
      window.open("/settings?from=chat#appearance", "_blank", "noopener");
    });
    expect(await windowIds()).toEqual([originalId]);
    expect(await settings.evaluate(() => performance.timeOrigin)).toBe(documentStart);

    await settings.close();
    const reopened = app.waitForEvent("window");
    await home.bringToFront();
    await home.getByRole("link", { name: "Settings", exact: true }).click();
    const fresh = await reopened;
    await waitForApp(fresh);
    const nextId = await (await app.browserWindow(fresh)).evaluate((win) => win.id);
    expect(nextId).not.toBe(originalId);
    expect(await windowIds()).toEqual([nextId]);
  });

  for (const activation of ["activate", "second-instance"] as const) {
    test(`reopening Home via ${activation} preserves the independent Chat draft`, async ({
      desktop: { app, page: home },
    }) => {
      test.skip(activation === "activate" && process.platform !== "darwin", "Dock activation is macOS-specific");
      const opened = app.waitForEvent("window");
      await home.getByRole("link", { name: "Chat demo" }).click();
      const chat = await opened;
      await waitForApp(chat);
      await chat.bringToFront();
      const draft = chat.getByRole("textbox", { name: "Message" });
      await draft.fill("Keep this conversation");
      await home.close();

      const reopened = app.waitForEvent("window");
      await app.evaluate(({ app: host }, event) => {
        host.emit(event);
        host.emit(event);
      }, activation);
      const next = await reopened;
      await waitForApp(next);
      await expect(next).toHaveURL("app://app/");
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
      await expect(chat).toHaveURL("app://app/chat");
      await expect(draft).toHaveValue("Keep this conversation");
    });
  }

  test("a failed appearance save leaves controls usable and the next command recovers persistence", async ({
    desktop: { page },
  }) => {
    const errors: string[] = [];
    const onError = (error: Error) => errors.push(error.message);
    page.on("pageerror", onError);
    const preferenceKey = storageKey("visual-preferences");
    const original = await page.evaluateHandle(() => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- Retained only for restoration on the same prototype.
      return Storage.prototype.setItem;
    });
    const notice = page.getByText("Appearance settings could not be saved.");
    try {
      await choose(page, "Direction", "rtl", "RTL");
      const saved = await page.evaluate((key) => localStorage.getItem(key), preferenceKey);
      expect(saved).not.toBeNull();
      // Fail only this persistence boundary, after startup; use the real controls and manager.
      await page.evaluate((key) => {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Called below with the original Storage receiver.
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (name, value) {
          if (this === localStorage && name === key)
            throw new DOMException("Injected quota failure", "QuotaExceededError");
          setItem.call(this, name, value);
        };
      }, preferenceKey);
      try {
        await choose(page, "Motion", "reduce", "Reduced");
        await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
        await expect(notice).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe(saved);
        const draft = page.getByRole("textbox", { name: "Follow-up note" });
        await draft.fill("Still usable after a failed save");
        await expect(draft).toHaveValue("Still usable after a failed save");
      } finally {
        await page.evaluate((setItem) => {
          Storage.prototype.setItem = setItem;
        }, original);
      }
      // A new command must save both the unsaved motion preference and the new direction.
      await choose(page, "Direction", "ltr", "LTR");
      await expect(notice).toBeHidden();
      await page.reload();
      await waitForApp(page);
      await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
      await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
      await expect(notice).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await original.dispose();
      page.off("pageerror", onError);
    }
  });

  for (const trigger of ["renderer child", "registry open", "quit", "retry"] as const) {
    test(`a pending native write survives reload and recovers on ${trigger}`, async ({
      desktop,
      launchApp,
      userDataDir,
    }) => {
      const { app, page } = desktop;
      if (trigger === "registry open") {
        const opened = app.waitForEvent("window");
        await page.evaluate(() => {
          window.open("/settings", "_blank", "noopener");
        });
        await waitForApp(await opened);
      }
      const mirrorFile = join(userDataDir, "visual.json");
      // Obstruct the final rename in this fresh profile, independently of the writer's temporary path.
      await mkdir(mirrorFile);
      let pending: string | null;
      try {
        await choose(page, "Color scheme", "dark", "Dark");
        const retry = page.getByRole("button", { name: "Retry", exact: true });
        await expect(retry).toBeVisible();
        const snapshot = await page.evaluate(() => window.desktop!.readVisual());
        pending = snapshot.record;
        expect(snapshot.pending).toBe(true);
        expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
        await page.reload();
        await waitForApp(page);
        await expect(retry).toBeVisible();
        expect(await page.evaluate(() => window.desktop!.visualSeed)).toEqual(snapshot);
      } finally {
        await rmdir(mirrorFile);
      }
      if (trigger === "retry") {
        await page.getByRole("button", { name: "Retry", exact: true }).click();
        await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeHidden();
      } else if (trigger === "quit") {
        await quit(desktop);
        expect(await readFile(mirrorFile, "utf8")).toBe(pending);
        const next = await launchApp();
        expect(await next.page.evaluate(() => window.desktop!.visualSeed)).toEqual({ record: pending, pending: false });
      } else {
        if (trigger === "registry open") await page.close();
        const opened = app.waitForEvent("window");
        if (trigger === "registry open")
          await app.evaluate(({ app: host }) => {
            host.emit("second-instance");
          });
        else await page.getByRole("link", { name: "Settings", exact: true }).click();
        const child = await opened;
        await waitForApp(child);
        expect(await child.evaluate(() => window.desktop!.visualSeed)).toEqual({ record: pending, pending: false });
        await expect(child.locator("html")).toHaveAttribute("data-color-scheme", "dark");
        if (!page.isClosed()) {
          await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
          await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeHidden();
        }
      }
      expect(await readFile(mirrorFile, "utf8")).toBe(pending);
    });
  }

  test("a reload before the native acknowledgement recovers the Web command", async ({ desktop: { app, page } }) => {
    const fault = await holdNativePush(app, page);
    try {
      await choose(page, "Direction", "rtl", "RTL");
      await fault.evaluate((f) => f.wait());
      await fault.evaluate((f) => f.arm());
      expect(await page.evaluate(() => window.desktop!.readVisual().record)).toBeNull();
      await page.reload();
      await waitForApp(page);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      expect(await page.evaluate(() => window.desktop!.visualSeed?.record)).toBeNull();
      await fault.evaluate((f) => f.wait());
    } finally {
      await fault.evaluate((f) => f.restore());
      await fault.dispose();
    }
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => window.desktop!.readVisual().record))
      .toBe(await page.evaluate((key) => localStorage.getItem(key), storageKey("visual-preferences")));
  });

  test("cold launch repairs the mirror after exit before native delivery", async ({ launchApp, target }) => {
    const first = await launchApp();
    const key = storageKey("visual-preferences");
    const held = await holdNativePush(first.app, first.page);
    let wire: string | null;
    let killed = false;
    try {
      await choose(first.page, "Color scheme", "dark", "Dark");
      await held.evaluate((gate) => gate.wait());
      wire = await first.page.evaluate((name) => localStorage.getItem(name), key);
      expect(visualRecordKernel.decode(wire).record?.preferences.colorScheme).toBe("dark");
      await first.page.evaluate((name) => {
        document.cookie = name + "=; Path=/; Max-Age=0";
      }, cookieName("visual"));
      await first.app.evaluate(async ({ session }) => {
        const appSession = session.fromPartition("persist:app");
        appSession.flushStorageData();
        await appSession.cookies.flushStore();
      });
      expect(await first.page.evaluate(() => window.desktop!.readVisual().record)).toBeNull();
      process.kill(first.pid, "SIGKILL");
      killed = true;
      await expect.poll(() => targetProcesses(target), { timeout: 10000 }).toEqual([]);
    } finally {
      if (!killed) {
        await held.evaluate((gate) => gate.restore());
        await held.dispose();
      }
    }
    const next = await launchApp();
    expect(await next.page.evaluate(() => window.desktop!.visualSeed?.record)).toBeNull();
    await expect.poll(() => next.page.evaluate(() => window.desktop!.readVisual().record)).toBe(wire);
    await expect(next.page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
  });

  for (const scenario of [
    { system: "dark", preference: "light", option: "Light", background: "rgb(250, 250, 250)" },
    { system: "light", preference: "dark", option: "Dark", background: "rgb(23, 25, 29)" },
  ] as const) {
    test(`explicit ${scenario.preference} styles override the ${scenario.system} system preference`, async ({
      desktop: { app, page },
    }) => {
      await page.emulateMedia({ colorScheme: scenario.system });
      try {
        await choose(page, "Color scheme", scenario.preference, scenario.option);
        await expect
          .poll(() =>
            app.evaluate(({ nativeTheme }) => ({
              source: nativeTheme.themeSource,
              dark: nativeTheme.shouldUseDarkColors,
            })),
          )
          .toEqual({ source: scenario.preference, dark: scenario.preference === "dark" });
        // Native theme synchronization must not remove the opposing renderer media emulation.
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
          scenario.system === "dark",
        );
        await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scenario.preference);
        await expect(page.locator("body")).toHaveCSS("background-color", scenario.background);
        await expect(page.locator("body")).toHaveCSS("color-scheme", scenario.preference);
        await expect(page.getByRole("textbox", { name: "Follow-up note" })).toHaveCSS(
          "color-scheme",
          scenario.preference,
        );
        await page.reload();
        await waitForApp(page);
        await expect(page.locator("body")).toHaveCSS("background-color", scenario.background);
        await expect(page.locator("body")).toHaveCSS("color-scheme", scenario.preference);
      } finally {
        await page.emulateMedia({ colorScheme: null });
      }
    });
  }

  test("Tailwind utilities override the demo CSS Module in the components layer", async ({ desktop: { page } }) => {
    const card = page.locator("[data-demo-draft]");
    const originalPadding = await card.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingTop));
    expect(originalPadding).toBeGreaterThan(0);
    expect(originalPadding).toBeLessThan(64);
    // pt-16 already occurs in the root fallback, so this tests a utility emitted in the real build.
    await card.evaluate((element) => element.classList.add("pt-16"));
    try {
      await expect(card).toHaveCSS("padding-top", "64px");
    } finally {
      await card.evaluate((element) => element.classList.remove("pt-16"));
    }
    await expect(card).toHaveCSS("padding-top", `${originalPadding}px`);

    const colorScheme = page.getByRole("combobox", { name: "Color scheme", exact: true });
    if (await colorScheme.evaluate((element) => element.tagName === "SELECT")) {
      // Demo controls must not override the shared Core appearance component's module styles.
      await expect
        .poll(() =>
          colorScheme.evaluate((element) => {
            const label = element.closest("label");
            if (!label) throw new Error("Core appearance select has no label ancestor");
            const style = getComputedStyle(label);
            return { display: style.display, gap: style.gap };
          }),
        )
        .toEqual({ display: "grid", gap: "6.4px" });
      await expect(colorScheme).toHaveCSS("border-radius", "6.4px");
    }
  });

  test("visual controls persist through reload and use the durable desktop color scheme", async ({
    desktop: { app, page },
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await choose(page, "Color scheme", "dark", "Dark");
    await choose(page, "Direction", "rtl", "RTL");
    await choose(page, "Motion", "reduce", "Reduced");
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()),
      )
      .toBe("#17191d");
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    await expect
      .poll(async () => JSON.parse(await readFile(join(userData, "visual.json"), "utf8")))
      .toMatchObject({ version: 1, preferences: { colorScheme: "dark", direction: "rtl", reducedMotion: "reduce" } });
    await page.reload();
    await waitForApp(page);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "reduce");
    await choose(page, "Color scheme", "light", "Light");
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()),
      )
      .toBe("#ffffff");
    // Use Chromium's native media value for the System check instead of Playwright's media override.
    await page.emulateMedia({ colorScheme: null });
    await choose(page, "Color scheme", "auto", "System");
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", systemDark ? "dark" : "light");
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase()),
      )
      .toBe(systemDark ? "#17191d" : "#ffffff");
    // Mantine integrations also exercise the real native pointer path through portals.
    const preview = page.getByRole("button", { name: "Preview options", exact: true });
    if (await preview.count()) {
      await preview.click();
      await page.getByRole("menuitem", { name: "Open dialog" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCSS("direction", "rtl");
      await page.getByRole("button", { name: "Close preview" }).click();
      await expect(page.getByRole("dialog")).toBeHidden();
      await expect(preview).toBeFocused();
    }
    expect(errors).toEqual([]);
  });

  test("reopening a macOS window uses the committed theme at creation", async ({ desktop: { app, page } }) => {
    test.skip(process.platform !== "darwin", "Other platforms quit after their last window closes");
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const preference = systemDark ? "light" : "dark";
    await choose(page, "Color scheme", preference, systemDark ? "Light" : "Dark");
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    await expect
      .poll(async () => JSON.parse(await readFile(join(userData, "visual.json"), "utf8")))
      .toMatchObject({ version: 1, preferences: { colorScheme: preference } });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0);
    const initialColor = await app.evaluate(
      ({ app: electronApp }) =>
        new Promise<string>((resolve) => {
          electronApp.once("browser-window-created", (_event, window) =>
            queueMicrotask(() => resolve(window.getBackgroundColor().toLowerCase())),
          );
          electronApp.emit("activate");
        }),
    );
    expect(initialColor).toBe(systemDark ? "#ffffff" : "#17191d");
  });
});
