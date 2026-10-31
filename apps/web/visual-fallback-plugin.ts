import type { Plugin } from "vite";

import { createVisualFallbackCss } from "./src/app/managers/visual/mantine/fallback.ts";
/** Vite tracks the imported theme as a config dependency and reloads on changes. */
export function visualFallbackPlugin(): Plugin {
  const id = "virtual:visual-fallback.css";
  return {
    name: "visual-fallback",
    enforce: "pre",
    resolveId(source) {
      return source === id ? "\0" + id : null;
    },
    load(source) {
      return source === "\0" + id ? createVisualFallbackCss() : null;
    },
  };
}
