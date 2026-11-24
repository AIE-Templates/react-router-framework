import { expect, test, waitForApp } from "./desktop.ts";

// Explicit template coverage: derived apps may remove this suite with features/demo.
test.describe("demo layout", { tag: "@demo" }, () => {
  test("the demo home renders its content inside the real application root", async ({ desktop: { page } }) => {
    await expect(page.getByRole("heading", { name: "Leads", level: 1, exact: true })).toBeVisible();
    await expect(page.getByText("Host: desktop.")).toBeVisible();
  });

  test("the same CRM report is reachable in both layouts and the lead note survives", async ({ desktop: { page } }) => {
    const shell = page.getByRole("combobox", { name: "App shell" });
    await page.getByRole("textbox", { name: "Follow-up note" }).fill("Schedule a walkthrough");
    await page.getByRole("link", { name: "Reports", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sales report", exact: true })).toBeVisible();
    const total = page.getByText("$30,000", { exact: true });
    await expect(total).toBeVisible();
    await shell.selectOption("basic");
    await expect(page).toHaveURL(/\/reports\/sales\?shell=basic$/);
    await expect(total).toBeVisible();
    const sidebar = page.getByRole("navigation", { name: "CRM pages" });
    await sidebar.getByRole("link", { name: "Deals" }).click();
    await expect(page.getByRole("cell", { name: "$18,000" })).toBeVisible();
    await sidebar.getByRole("link", { name: "Sales report" }).click();
    await expect(total).toBeVisible();
    await sidebar.getByRole("link", { name: "Leads" }).click();
    await expect(page.getByRole("textbox", { name: "Follow-up note" })).toHaveValue("Schedule a walkthrough");
  });

  test("custom editor shares resizable tracks and hands the top band back when hidden", async ({
    desktop: { page, app },
  }) => {
    await page.goto("app://app/?layout=editor");
    await waitForApp(page);
    const header = page.locator('[data-window-header="primary"]');
    const fallback = page.locator(".root-chrome-fallback");
    const editor = page.getByRole("main");
    const files = page.getByRole("slider", { name: "File pane width" });
    await expect(header).toHaveCSS("app-region", "drag");
    await expect(header.getByRole("link")).toHaveCSS("app-region", "no-drag");
    await expect(fallback).toHaveCSS("display", "none");
    const before = await header.boundingBox();
    await files.focus();
    await files.press("End");
    await expect.poll(async () => (await header.boundingBox())?.x).toBeGreaterThan(before!.x);
    for (const fullscreen of [true, false]) {
      await app.evaluate(
        ({ BrowserWindow }, enabled) => BrowserWindow.getAllWindows()[0].setFullScreen(enabled),
        fullscreen,
      );
      await expect(page.locator("html")).toHaveAttribute("data-fullscreen", String(fullscreen));
      const top = await header.boundingBox();
      const body = await editor.boundingBox();
      expect(top!.x).toBeCloseTo(body!.x, 0);
      expect(top!.width).toBeCloseTo(body!.width, 0);
      expect(top!.y + top!.height).toBeCloseTo(body!.y, 0);
    }
    await page.getByRole("button", { name: "Notes.md" }).click();
    await page.getByRole("textbox", { name: "Notes.md" }).fill("Meeting notes");
    await header.evaluate((el) => {
      el.setAttribute("hidden", "");
    });
    await expect(fallback).not.toHaveCSS("display", "none");
    await expect(page.locator('[data-window-header="secondary"]')).toHaveCSS("app-region", "no-drag");
    await header.evaluate((el) => {
      el.removeAttribute("hidden");
    });
    await expect(fallback).toHaveCSS("display", "none");
    await header.getByRole("link").click();
    await expect(page.getByRole("heading", { name: "Leads", exact: true })).toBeVisible();
  });

  test("equal tracks retain native control clearance after CSS reordering and RTL", async ({ desktop: { page } }) => {
    await page.goto("app://app/?layout=editor");
    await waitForApp(page);
    const header = page.locator('[data-window-header="primary"]');
    await header.waitFor();
    await page.evaluate(() => {
      // Model a left traffic-light cluster and a right caption-button cluster on every platform.
      const css = document.querySelector<HTMLStyleElement>("#window-chrome-safety")!;
      css.textContent = css.textContent
        .replaceAll(/env\(titlebar-area-x,[^)]+\)/g, "78px")
        .replaceAll(/env\(titlebar-area-width,[^)]+\)/g, "calc(100vw - 228px)");
      document.querySelector<HTMLElement>("[data-window-columns]")!.style.gridTemplateColumns = "1fr 1fr";
    });
    const check = async (physicalSide: "left" | "right") => {
      await expect
        .poll(() =>
          header.evaluate((el, side) => {
            const bounds = el.getBoundingClientRect();
            const child = el.querySelector("strong")!.getBoundingClientRect();
            const link = el.querySelector("a")!.getBoundingClientRect();
            return (
              (side === "left" ? bounds.left === 0 : bounds.right === innerWidth) &&
              [child, link].every((r) => r.left >= 78 && r.right <= innerWidth - 150)
            );
          }, physicalSide),
        )
        .toBe(true);
    };
    await check("right");
    await header.evaluate((el) => {
      el.parentElement!.style.order = "-1";
    });
    await check("left");
    await page.evaluate(() => {
      document.documentElement.dir = "rtl";
    });
    await check("right");
  });

  test("custom headers truncate titles and paint the Windows native-overlay separator", async ({
    desktop: { page },
  }) => {
    await page.goto("app://app/?layout=editor");
    await waitForApp(page);
    const header = page.locator('[data-window-header="primary"]');
    await header.waitFor();
    const result = await header.evaluate((el) => {
      document.documentElement.dataset.platform = "win32";
      document.documentElement.dataset.chromeMode = "native-overlay";
      const title = el.querySelector("strong")!;
      title.textContent = "Quarterly report ".repeat(100);
      const style = getComputedStyle(el);
      return {
        truncated: title.scrollWidth > title.clientWidth && getComputedStyle(title).textOverflow === "ellipsis",
        actionInside: el.querySelector("a")!.getBoundingClientRect().right <= el.getBoundingClientRect().right,
        width: style.borderBottomWidth,
        line: style.borderBottomStyle,
      };
    });
    expect(result).toEqual({ truncated: true, actionInside: true, width: "1px", line: "solid" });
  });

  test("custom editor owns a safe first paint without hydration or external styles", async ({ desktop: { page } }) => {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setScriptExecutionDisabled", { value: true });
    try {
      await page.goto("app://app/?layout=editor", { waitUntil: "domcontentloaded" });
      if (process.env.SSR === "false") {
        await expect(page.locator("[data-window-header]")).toHaveCount(0);
        const fallback = page.locator(".root-chrome-fallback");
        await expect(fallback).not.toHaveCSS("display", "none");
        const { band, contentTop, safeBottom } = await fallback.evaluate((el) => ({
          band: el.getBoundingClientRect().height,
          contentTop: document.querySelector(".root-content")!.getBoundingClientRect().top,
          safeBottom: el.querySelector(".window-safe-drag")!.getBoundingClientRect().bottom,
        }));
        expect(band).toBeCloseTo(safeBottom, 0);
        expect(contentTop).toBeGreaterThanOrEqual(safeBottom);
        return;
      }
      const geometry = await page.evaluate(() => {
        for (const sheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) sheet.disabled = true;
        const header = document.querySelector<HTMLElement>('[data-window-header="primary"]')!;
        const fallback = document.querySelector<HTMLElement>(".root-chrome-fallback")!;
        const items = [...document.querySelectorAll("[data-window-header] > :is(strong,a)")].map((el) =>
          el.getBoundingClientRect(),
        );
        const active = getComputedStyle(fallback).display === "none";
        header.hidden = true;
        const safe = fallback.querySelector(".window-safe-drag")!.getBoundingClientRect();
        const clearance =
          items.length === 3 &&
          items.every(
            (r) =>
              r.width > 0 &&
              (r.top >= safe.bottom || (r.top >= safe.top && r.left >= safe.left && r.right <= safe.right)),
          );
        return {
          active,
          clearance,
          restored: getComputedStyle(fallback).display !== "none",
          hydrated: document.documentElement.dataset.hydrated === "true",
        };
      });
      expect(geometry).toEqual({ active: true, clearance: true, restored: true, hydrated: false });
    } finally {
      await session.send("Emulation.setScriptExecutionDisabled", { value: false });
      await session.detach();
    }
  });

  test("fallback drag geometry uses physical WCO coordinates in LTR and RTL", async ({ desktop: { page } }) => {
    await page.locator(".app-shell").waitFor();
    const rectangles = await page.evaluate(() => {
      // Supply asymmetric WCO geometry even on hosts with no native overlay.
      const css = document.querySelector<HTMLStyleElement>("#window-chrome-safety")!;
      const values = { x: 36, y: 5, width: 260, height: 40 };
      for (const [field, value] of Object.entries(values)) {
        css.textContent = css.textContent.replaceAll(
          new RegExp(`env\\(titlebar-area-${field},[^)]+\\)`, "g"),
          `${value}px`,
        );
      }
      document.querySelector<HTMLElement>(".app-shell")!.hidden = true;
      const drag = document.querySelector<HTMLElement>(".window-safe-drag")!;
      return ["ltr", "rtl"].map((dir) => {
        document.documentElement.dir = dir;
        const { left, top, width, height } = drag.getBoundingClientRect();
        return { left, top, width, height };
      });
    });
    for (const rect of rectangles) expect(rect).toEqual({ left: 36, top: 5, width: 260, height: 40 });
  });

  test("standalone chrome preserves a long title and keeps wrapped actions in bounds", async ({
    desktop: { page },
  }) => {
    await page.setViewportSize({ width: 480, height: 720 });
    await page.getByRole("combobox", { name: "Title bar" }).selectOption("standalone");
    const header = page.locator(".shell-titlebar-content");
    await expect(header).toBeVisible();
    const measurement = await header.evaluate((bar) => {
      const title = bar.querySelector("strong")!;
      const actions = bar.querySelector<HTMLElement>("[data-window-interactive]")!;
      const fullTitle = "Standalone title ".repeat(30);
      title.textContent = fullTitle;
      const buttons = Array.from({ length: 3 }, () => {
        const button = document.createElement("button");
        button.textContent = "Title bar action";
        button.style.width = "13rem";
        return button;
      });
      actions.replaceChildren(buttons[0]);
      const truncated =
        title.clientWidth > 0 &&
        title.scrollWidth > title.clientWidth &&
        getComputedStyle(title).textOverflow === "ellipsis" &&
        title.textContent === fullTitle;
      actions.append(...buttons.slice(1));
      const bounds = bar.getBoundingClientRect();
      const controls = buttons.map((button) => button.getBoundingClientRect());
      return {
        truncated,
        wrapped: controls[2].top >= controls[0].bottom,
        fit: controls.every(
          (rect) =>
            rect.left >= bounds.left &&
            rect.right <= bounds.right &&
            rect.top >= bounds.top &&
            rect.bottom <= bounds.bottom,
        ),
      };
    });
    expect(measurement).toEqual({ truncated: true, wrapped: true, fit: true });
  });

  for (const fallback of [false, true]) {
    test(`drawer anchors to the visible layout after a hidden sibling (JS fallback: ${fallback})`, async ({
      desktop: { page },
    }) => {
      if (fallback) {
        await page.addInitScript(() => {
          const supports = CSS.supports.bind(CSS);
          Object.defineProperty(CSS, "supports", {
            value: (query: string, value?: string) =>
              query.includes("anchor-scope") ? false : value === undefined ? supports(query) : supports(query, value),
          });
        });
      }
      await page.goto("app://app/");
      await waitForApp(page);
      await page.setViewportSize({ width: 600, height: 720 });
      const header = page.locator('[data-window-header="primary"]');
      await header.waitFor();
      await header.evaluate((el) => {
        const layout = el.closest("[data-window-layout]")!;
        const hidden = layout.cloneNode(false);
        if (hidden instanceof HTMLElement) hidden.hidden = true;
        layout.before(hidden);
      });
      await page.getByRole("button", { name: "Switch area" }).click();
      const box = (await header.boundingBox())!;
      await expect(page.locator(".root-chrome-fallback")).toHaveCSS("display", "none");
      if (fallback)
        await expect
          .poll(() =>
            page
              .locator(".shell-body")
              .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue("--app-layout-navigation-top"))),
          )
          .toBeCloseTo(box.height, 0);
      const drawer = (await page.locator(".shell-nav").boundingBox())!;
      expect(drawer.y).toBeCloseTo(box.y + box.height, 0);
    });
  }

  test("area switcher starts at the shell body when a standalone layout has no header", async ({
    desktop: { page },
  }) => {
    await page.setViewportSize({ width: 600, height: 720 });
    await page.goto("app://app/?header=standalone");
    await waitForApp(page);
    await page.locator("[data-window-layout]").evaluate((el) => el.remove());
    await page.getByRole("button", { name: "Switch area" }).click();
    const drawer = await page.locator(".shell-nav").boundingBox();
    const body = await page.locator(".shell-body").boundingBox();
    expect(drawer!.y).toBeCloseTo(body!.y, 0);
  });

  test("all three drawers start below a wrapping workspace header", async ({ desktop: { page } }) => {
    await page.setViewportSize({ width: 600, height: 720 });
    const sidebar = page.getByRole("button", { name: "Sidebar", exact: true });
    if ((await sidebar.getAttribute("aria-expanded")) === "false") await sidebar.click();
    await page.getByRole("button", { name: "Auxiliary", exact: true }).click();
    await page.getByRole("button", { name: "Switch area", exact: true }).click();
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
    const draft = page.getByRole("textbox", { name: "Follow-up note" });
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
    await page.getByRole("textbox", { name: "Follow-up note" }).fill("keep this draft");
    await page.evaluate(() => Reflect.set(window, "layoutDocument", true));
    await page.getByRole("link", { name: "Sales", exact: true }).click();
    await expect(page).toHaveURL("app://app/?header=standalone&shell=navigation");
    await expect(page.getByRole("textbox", { name: "Follow-up note" })).toHaveValue("keep this draft");
    expect(await page.evaluate(() => Reflect.get(window, "layoutDocument"))).toBe(true);
    await expect(page.getByRole("main")).toHaveCount(1);
  });

  test("container scrolling resets on navigation and restores on back and forward", async ({ desktop: { page } }) => {
    // SPA document hydration can finish before the initial route module resolves.
    await expect(page.locator('[data-scroll-restoration-id="sales:workspace"]')).toBeVisible();
    // Make both actual CSS scroll containers overflow without adding test-only application routes.
    await page.evaluate(async () => {
      const root = document.querySelector<HTMLElement>(".root-content")!;
      const workspace = document.querySelector<HTMLElement>('[data-scroll-restoration-id="sales:workspace"]')!;
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
    const workspace = page.locator('[data-scroll-restoration-id="sales:workspace"]');
    await expect(root).toHaveJSProperty("scrollTop", 120);
    await expect(workspace).toHaveJSProperty("scrollTop", 240);
    // Avoid Playwright scrolling Home into view before the click and changing the position under test.
    await page.getByRole("link", { name: "Sales", exact: true }).evaluate((element) => {
      if (element instanceof HTMLElement) element.click();
    });
    await expect(page).toHaveURL("app://app/?shell=navigation");
    await expect(root).toHaveJSProperty("scrollTop", 0);
    await expect(workspace).toHaveJSProperty("scrollTop", 0);
    await page.evaluate(async () => {
      document.querySelector<HTMLElement>(".root-content")!.scrollTop = 80;
      document.querySelector<HTMLElement>('[data-scroll-restoration-id="sales:workspace"]')!.scrollTop = 60;
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
