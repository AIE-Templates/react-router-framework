import { DEFAULT_THEME, defaultCssVariablesResolver } from "@mantine/core";
import { expect, it } from "vitest";

import { BREAKPOINTS } from "~/config/breakpoints";

import { createVisualFallbackCss } from "./fallback";
import { resolvedVisualTheme, visualVariables } from "./theme";

const mappings = {
  body: "background",
  text: "foreground",
  bright: "foreground",
  "default-color": "foreground",
  dimmed: "muted-foreground",
  placeholder: "muted-foreground",
  default: "card",
  "default-hover": "muted",
  "default-border": "input",
};

it("derives both Mantine palettes, typography, radius and breakpoints from app semantics", () => {
  const variables = visualVariables(resolvedVisualTheme);
  for (const scheme of ["light", "dark"] as const) {
    for (const [mantine, app] of Object.entries(mappings)) {
      expect(variables[scheme][`--mantine-color-${mantine}`]).toBe(`var(--app-color-${app})`);
    }
  }
  expect(resolvedVisualTheme.fontFamily).toBe("var(--app-font-sans)");
  expect(resolvedVisualTheme.headings.fontFamily).toBe("var(--app-font-sans)");
  expect(resolvedVisualTheme.radius).toEqual({ ...DEFAULT_THEME.radius, md: "var(--app-radius)" });
  expect(resolvedVisualTheme.defaultRadius).toBe("md");
  expect(resolvedVisualTheme.breakpoints).toEqual(BREAKPOINTS);
});

it("keeps all default variables and semantic overrides in the dynamic prepaint fallback", () => {
  const css = createVisualFallbackCss();
  const defaults = defaultCssVariablesResolver(resolvedVisualTheme);
  const custom = visualVariables(resolvedVisualTheme);
  const [light, dark] = css.split("@media(prefers-color-scheme:dark)");
  expect(css).toMatch(/^@layer theme,base,mantine,components,utilities;/);
  for (const [scheme, block] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    expect(block).toContain(":root:not([data-color-scheme]):not([data-mantine-color-scheme])");
    const expected = { ...defaults[scheme], ...custom[scheme] };
    for (const [key, value] of Object.entries(expected)) expect(block).toContain(`${key}:${value};`);
    expect(block).toContain(`color-scheme:${scheme};`);
  }
  for (const [key, value] of Object.entries({ ...defaults.variables, ...custom.variables })) {
    expect(light).toContain(`${key}:${value};`);
  }
  expect(css).not.toContain("undefined");
});
