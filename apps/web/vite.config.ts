import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

import { honoServer } from "./src/host/vite-plugin.ts";

export default defineConfig({
  environments: {
    ssr: {
      resolve: {
        conditions: ["@repo/source", ...defaultServerConditions],
        // A dev dependency of @repo/server, imported only in development: keep it out of the bundle
        // (Vite only externalizes this app's own dependencies by default).
        external: ["pino-pretty"],
      },
      build: {
        // Bundle the host app (with @repo/server) into the React Router server build, so
        // build/server/index.js exports both.
        rollupOptions: {
          input: "./src/host/index.ts",
          // src/host/app.ts imports the server build lazily, for dev and tests; in this bundle
          // src/host/index.ts also re-exports it statically, which is intended.
          checks: { ineffectiveDynamicImport: false },
        },
      },
    },
  },
  // honoServer() must come before reactRouter() so its middleware handles requests first.
  plugins: [tailwindcss(), honoServer(), reactRouter()],
  resolve: {
    // Workspace packages (@repo/*) resolve to their TypeScript source, so they build and hot-reload
    // with the app; their `dist` is for consumers outside the workspace.
    conditions: ["@repo/source", ...defaultClientConditions],
    tsconfigPaths: true,
  },
});
