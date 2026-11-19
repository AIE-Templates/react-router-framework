import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { storageKey } from "@repo/shared";

import { expect, test, waitForApp } from "./desktop.ts";

async function choose(page: Page, label: string, value: string, option: string) {
  const control = page.getByRole("combobox", { name: label, exact: true });
  if (await control.evaluate((element) => element.tagName === "SELECT")) await control.selectOption(value);
  else {
    await control.click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
}

// These controls and layout expectations belong to the disposable demo.
test.describe("demo appearance", { tag: "@demo" }, () => {
  test("appearance changes reach other open windows without losing their drafts", async ({
    desktop: { app, page },
  }) => {
    const opened = app.waitForEvent("window");
    await page.evaluate(() => {
      window.open("/");
    });
    const peer = await opened;
    await waitForApp(peer);
    const draft = peer.getByRole("textbox", { name: "Module draft" });
    await peer.bringToFront();
    await draft.fill("unsaved in peer");
    await expect(draft).toHaveValue("unsaved in peer");
    await page.bringToFront();
    await choose(page, "Color scheme", "dark", "Dark");
    await expect(peer.locator("html")).toHaveAttribute("data-color-scheme", "dark");
    await expect(peer.locator("html")).toHaveAttribute("data-mantine-color-scheme", "dark");
    await peer.bringToFront();
    await choose(peer, "Direction", "rtl", "RTL");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(draft).toHaveValue("unsaved in peer");
  });

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
    const notice = page.getByText("Appearance is available for this session; settings could not be saved.");
    try {
      await choose(page, "Color scheme", "light", "Light");
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
        await choose(page, "Color scheme", "dark", "Dark");
        await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
        await expect(notice).toBeVisible();
        expect(await page.evaluate((key) => localStorage.getItem(key), preferenceKey)).toBe(saved);
        const draft = page.getByRole("textbox", { name: "Module draft" });
        await draft.fill("Still usable after a failed save");
        await expect(draft).toHaveValue("Still usable after a failed save");
      } finally {
        await page.evaluate((setItem) => {
          Storage.prototype.setItem = setItem;
        }, original);
      }
      // A new command must save both the unsaved color scheme and the new direction.
      await choose(page, "Direction", "rtl", "RTL");
      await expect(notice).toBeHidden();
      await page.reload();
      await waitForApp(page);
      await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(notice).toBeHidden();
      expect(errors).toEqual([]);
    } finally {
      await original.dispose();
      page.off("pageerror", onError);
    }
  });

  for (const scenario of [
    { system: "dark", preference: "light", option: "Light", background: "rgb(250, 250, 250)" },
    { system: "light", preference: "dark", option: "Dark", background: "rgb(23, 25, 29)" },
  ] as const) {
    test(`explicit ${scenario.preference} styles override the ${scenario.system} system preference`, async ({
      desktop: { page },
    }) => {
      await page.emulateMedia({ colorScheme: scenario.system });
      try {
        await choose(page, "Color scheme", scenario.preference, scenario.option);
        // Native theme synchronization must not remove the opposing renderer media emulation.
        expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches)).toBe(
          scenario.system === "dark",
        );
        await expect(page.locator("html")).toHaveAttribute("data-color-scheme", scenario.preference);
        await expect(page.locator("body")).toHaveCSS("background-color", scenario.background);
        await expect(page.locator("body")).toHaveCSS("color-scheme", scenario.preference);
        await expect(page.getByRole("textbox", { name: "Module draft" })).toHaveCSS(
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

  test("visual controls persist through reload and synchronize the independent native mirror", async ({
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
      .poll(async () => JSON.parse(await readFile(join(userData, "visual-theme.json"), "utf8")))
      .toEqual({ version: 1, colorScheme: "dark" });
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
    await choose(page, "Color scheme", "auto", "System");
    const systemDark = await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches);
    await expect(page.locator("html")).toHaveAttribute("data-color-scheme", systemDark ? "dark" : "light");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
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

  test("reopening a macOS window uses the current mirror before renderer synchronization", async ({
    desktop: { app, page },
  }) => {
    test.skip(process.platform !== "darwin", "Other platforms quit after their last window closes");
    const systemDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
    const preference = systemDark ? "light" : "dark";
    await choose(page, "Color scheme", preference, systemDark ? "Light" : "Dark");
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    await expect
      .poll(async () => JSON.parse(await readFile(join(userData, "visual-theme.json"), "utf8")))
      .toEqual({ version: 1, colorScheme: preference });
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
