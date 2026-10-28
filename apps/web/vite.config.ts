import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defaultClientConditions, defaultServerConditions, defineConfig } from "vite";

import { honoServer } from "./src/host/vite-plugin.ts";

export default defineConfig({
  // The desktop shell's dev script (apps/desktop/scripts/dev.ts) serves this dev server through
  // app://, so the HMR client must be told where the WebSocket is; from an app:// page it would
  // otherwise connect to the page's own host.
  server: process.env.DESKTOP_DEV
    ? {
        hmr: {
          host: "localhost",
          protocol: "ws",
          // The page's location has no port under app://, so the client must be told the server's.
          clientPort: Number(process.env.DESKTOP_DEV_PORT) || undefined,
        },
      }
    : undefined,
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
