import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

import { mantineCss } from "./vite-plugins/styles.ts";
import { visualFallbackPlugin } from "./vite-plugins/visual-fallback.ts";

export default defineConfig({
  environments: {
    ssr: {
      resolve: {
        conditions: ["@repo/source", ...defaultServerConditions],
      },
    },
  },
  plugins: [visualFallbackPlugin(), tailwindcss(), reactRouter()],
  resolve: {
    // Workspace packages (@repo/*) resolve to their TypeScript source, so they build and hot-reload
    // with the app; their `dist` is for consumers outside the workspace.
    conditions: ["@repo/source", ...defaultClientConditions],
    tsconfigPaths: true,
  },
  css: mantineCss,
});
