import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildMacosAddon } from "../scripts/build-macos-addon.ts";
import { test, expect, waitForApp } from "./desktop.ts";
import { pushVisual } from "./visual-mirror.ts";

test(
  "macOS editor keeps dark native buttons and anchors each text menu to its event",
  { tag: "@demo" },
  async ({ desktop: { app, page: home } }) => {
    test.skip(process.platform !== "darwin", "Reads AppKit window controls and menus");
    const directory = mkdtempSync(join(tmpdir(), "window-appearance-probe-"));
    const addon = join(directory, "probe.node");
    try {
      buildMacosAddon(join(import.meta.dirname, "window-appearance-probe.mm"), addon);
      const read = (editorButton = false) =>
        app.evaluate(
          ({ BrowserWindow }, request): string => {
            const reader: unknown = process.getBuiltinModule("module").createRequire(request.addon)(request.addon);
            if (typeof reader !== "function") throw new Error("Missing test probe");
            const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes("layout=editor"));
            return String(request.editorButton ? reader(win!.getNativeWindowHandle()) : reader());
          },
          { addon, editorButton },
        );
      const setTheme = (value: "light" | "dark") => pushVisual(home, { colorScheme: value });
      await setTheme("light");
      const opened = app.waitForEvent("window");
      await home.getByRole("link", { name: "Open editor" }).press("Enter");
      const editor = await opened;
      await waitForApp(editor);
      expect(await read(true)).toBe("NSAppearanceNameDarkAqua");
      for (const [page, field, appearance] of [
        [editor, "Brief.md", "NSAppearanceNameDarkAqua"],
        [home, "Follow-up note", "NSAppearanceNameAqua"],
      ] as const) {
        await (await app.browserWindow(page)).evaluate((win) => win.focus());
        await page.bringToFront();
        const input = page.getByRole("textbox", { name: field });
        await input.scrollIntoViewIfNeeded();
        const bounds = await input.boundingBox();
        if (!bounds) throw new Error("Text field is hidden");
        const position = { x: 24, y: 12 };
        await input.click({ button: "right", position });
        await expect.poll(() => read()).toMatch(new RegExp("^" + appearance + " "));
        const [, x, y] = (await read()).split(" ");
        // AppKit adds a small offset between the click point and the popup border.
        expect(Math.abs(Number(x) - (bounds.x + position.x))).toBeLessThan(20);
        expect(Math.abs(Number(y) - (bounds.y + position.y))).toBeLessThan(20);
      }
      for (const theme of ["dark", "light"] as const) {
        await setTheme(theme);
        expect(await read(true)).toBe("NSAppearanceNameDarkAqua");
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
