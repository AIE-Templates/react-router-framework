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
  const input = declarations({
    "--input-bg": "var(--app-color-card)", // naming-allow: Mantine Input wrapper variable
    "--input-bd": "var(--app-color-input)", // naming-allow: Mantine Input wrapper variable
    "--input-bd-focus": "var(--app-color-ring)", // naming-allow: Mantine Input wrapper variable
  });
  return `@layer theme,base,mantine,components,utilities;
@layer mantine {
  ${selector}{${declarations({ ...common, ...light })}}
  ${selector} .mantine-Input-wrapper[data-variant="default"]{${input}}
  @media(prefers-color-scheme:dark){${selector}{${declarations(dark)}}}
}`;
}
