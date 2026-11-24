import { expect, test, waitForApp } from "./desktop.ts";

// Explicit template coverage: derived apps may remove this suite with features/demo.
test.describe("demo layout", { tag: "@demo" }, () => {
  test("the demo home renders its content inside the real application root", async ({ desktop: { page } }) => {
    await expect(page.getByRole("heading", { name: "One application, three layout layers" })).toBeVisible();
    await expect(page.getByText("Host: desktop.")).toBeVisible();
  });

  test("all three drawers start below a wrapping workspace header", async ({ desktop: { page } }) => {
    await page.setViewportSize({ width: 600, height: 720 });
    await page.getByRole("button", { name: "Sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Auxiliary", exact: true }).click();
    await page.getByRole("button", { name: "App navigation", exact: true }).click();
    const positions = await page.evaluate(() => {
      const header = document.querySelector<HTMLElement>(".app-area-workspace > .app-area-header")!;
      const action = document.createElement("button");
      action.textContent = "Additional workspace action";
      action.style.flexBasis = "100%";
      header.append(action);
      const rect = header.getBoundingClientRect();
      return {
        height: rect.height,
        bottom: rect.bottom,
        drawers: [".shell-nav", ".app-area-sidebar", ".app-area-auxiliary"].map(
          (selector) => document.querySelector(selector)!.getBoundingClientRect().top,
        ),
      };
    });
    expect(positions.height).toBeGreaterThan(50);
    for (const top of positions.drawers) expect(Math.abs(top - positions.bottom)).toBeLessThanOrEqual(1);
  });

  test("real input drives client-side navigation and React state", async ({ desktop: { page } }) => {
    await page.getByRole("combobox", { name: "App shell" }).selectOption("basic");
    await expect(page).toHaveURL("app://app/?shell=basic");
    const draft = page.getByRole("textbox", { name: "Area draft" });
    await draft.fill("typed by Playwright");
    await expect(draft).toHaveValue("typed by Playwright");
    // The select is controlled by the URL: going back restores it without a document load.
    await page.goBack();
    await expect(page).toHaveURL("app://app/");
    await expect(page.getByRole("combobox", { name: "App shell" })).toHaveValue("navigation");
  });

  test("the demo title bar selection survives a document reload", async ({ desktop: { page } }) => {
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

  test("Home preserves the document, draft and existing query settings", async ({ desktop: { page } }) => {
    await page.getByRole("combobox", { name: "Title bar" }).selectOption("standalone");
    await page.getByRole("textbox", { name: "Area draft" }).fill("keep this draft");
    await page.evaluate(() => Reflect.set(window, "layoutDocument", true));
    await page.getByRole("link", { name: "Home", exact: true }).click();
    await expect(page).toHaveURL("app://app/?header=standalone&shell=navigation");
    await expect(page.getByRole("textbox", { name: "Area draft" })).toHaveValue("keep this draft");
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
});
