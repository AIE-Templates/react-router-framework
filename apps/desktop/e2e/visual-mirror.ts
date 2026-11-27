import type { Page } from "@playwright/test";
import { visualRecordKernel as records, type VisualPreferences } from "@repo/shared";

/** Exercise the application bridge on host-only pages, independently of the disposable settings UI. */
export async function pushVisual(page: Page, preferences: Partial<VisualPreferences>) {
  const snapshot = await page.evaluate(() => window.desktop!.readVisual());
  const previous = records.decode(snapshot.record).record;
  const raw = records.encode({ version: 1, stamp: records.nextStamp([previous]), preferences });
  const result = await page.evaluate((wire) => window.desktop!.pushVisual(wire), raw);
  if (result !== "ok") throw new Error("Visual mirror push returned " + result);
  return raw;
}

/** Read the hydrated build's rendering mode, including when a packaged app runs under a different shell environment. */
export async function isSsrBuild(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ssr: unknown = Reflect.get(window, "__reactRouterContext")?.ssr;
    if (typeof ssr !== "boolean") throw new Error("Missing React Router build mode");
    return ssr;
  });
}
