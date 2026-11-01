import { fileURLToPath } from "node:url";

import type { CSSOptions } from "vite";

import { BREAKPOINTS } from "../src/app/config/breakpoints.ts";

const tools = fileURLToPath(new URL("../src/app/styles/_mantine.scss", import.meta.url)).replaceAll("\\", "/");
const breakpoints = Object.entries(BREAKPOINTS)
  .map(([name, value]) => `$mantine-breakpoint-${name}: ${value}`)
  .join(", ");

/** Shared by application builds and tests; emits no CSS until a mixin is used. */
export const mantineCss: CSSOptions = {
  modules: { localsConvention: "camelCaseOnly" },
  preprocessorOptions: {
    scss: { additionalData: `@use ${JSON.stringify(tools)} as mantine with (${breakpoints});\n` },
  },
};
