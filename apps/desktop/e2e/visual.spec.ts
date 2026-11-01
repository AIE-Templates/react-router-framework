import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, test, waitForApp } from "./desktop.ts";

async function choose(page: Page, label: string, value: string, option: string) {
  const control = page.getByRole("combobox", { name: label, exact: true });
  if (await control.evaluate((element) => element.tagName === "SELECT")) await control.selectOption(value);
  else {
    await control.click();
    await page.getByRole("option", { name: option, exact: true }).click();
  }
}

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
      await expect(page.getByRole("textbox", { name: "Module draft" })).toHaveCSS("color-scheme", scenario.preference);
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
  const card = page.locator("#scratchpad");
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
