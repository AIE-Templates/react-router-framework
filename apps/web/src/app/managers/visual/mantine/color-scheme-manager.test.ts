import { expect, it, vi } from "vitest";

import { createVisualManager } from "../manager";
import { createMantineColorSchemeManager } from "./color-scheme-manager";
import { createVisualFallbackCss } from "./fallback";

it("breaks Mantine's subscribe/set feedback loop and releases replaced subscriptions", () => {
  const visual = createVisualManager();
  const manager = createMantineColorSchemeManager(visual);
  const notify = vi.fn<(value: "auto" | "light" | "dark") => void>((value) => manager.set(value));
  manager.subscribe(notify);
  manager.subscribe(notify);
  visual.actions.setColorSchemePreference("dark");
  expect(notify).toHaveBeenCalledExactlyOnceWith("dark");
  visual.actions.setDirection("rtl");
  expect(notify).toHaveBeenCalledTimes(1);
  manager.clear();
  expect(visual.getSnapshot().preferences).toMatchObject({ colorScheme: "auto", direction: "rtl" });
  manager.unsubscribe();
  manager.unsubscribe();
  visual.actions.setColorSchemePreference("light");
  expect(notify).toHaveBeenCalledTimes(2);
});

it("generates complete variable fallbacks guarded by both missing attributes", () => {
  const css = createVisualFallbackCss();
  expect(css).toContain(":root:not([data-color-scheme]):not([data-mantine-color-scheme])");
  expect(css).toContain("@media(prefers-color-scheme:dark)");
  expect(css).toContain("--mantine-color-body:var(--background)");
  expect(css).toContain("--mantine-color-scheme:light");
  expect(css).toContain("--mantine-color-scheme:dark");
  expect(css).not.toContain("undefined");
});
