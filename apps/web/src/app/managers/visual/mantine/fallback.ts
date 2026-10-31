import { defaultCssVariablesResolver } from "@mantine/core";

import { resolvedVisualTheme, visualVariables } from "./theme.ts";
const declarations = (values: Record<string, string>) =>
  Object.entries(values)
    .map(([key, value]) => `${key}:${value};`)
    .join("");

/** Complete variables, not Mantine's runtime deduplicated subset. */
export function createVisualFallbackCss() {
  const defaults = defaultCssVariablesResolver(resolvedVisualTheme);
  const custom = visualVariables(resolvedVisualTheme);
  const selector = ":root:not([data-color-scheme]):not([data-mantine-color-scheme])";
  const common = { ...defaults.variables, ...custom.variables };
  const light = { ...defaults.light, ...custom.light, "--mantine-color-scheme": "light", "color-scheme": "light" };
  const dark = { ...defaults.dark, ...custom.dark, "--mantine-color-scheme": "dark", "color-scheme": "dark" };
  return `@layer theme,base,mantine,components,utilities;@layer mantine {${selector}{${declarations({ ...common, ...light })}}@media(prefers-color-scheme:dark){${selector}{${declarations(dark)}}}}`;
}
