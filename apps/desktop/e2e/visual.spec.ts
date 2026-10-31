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
