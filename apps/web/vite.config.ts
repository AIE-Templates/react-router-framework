import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

export default defineConfig({
  environments: {
    ssr: {
      resolve: {
        conditions: ["@repo/source", ...defaultServerConditions],
      },
    },
  },
  plugins: [tailwindcss(), reactRouter()],
  resolve: {
    // Workspace packages (@repo/*) resolve to their TypeScript source, so they build and hot-reload
    // with the app; their `dist` is for consumers outside the workspace.
    conditions: ["@repo/source", ...defaultClientConditions],
    tsconfigPaths: true,
  },
});
