import { join } from "node:path";

import type { Config } from "@react-router/dev/config";
import { config as loadDotenv } from "dotenv";
import { expand } from "dotenv-expand";

// Load .env, if any, for `react-router dev` and `react-router build`: this file is the first thing they
// load, so this config and server code (through Vite) see the same variables as server.ts does in
// production. Vite itself only exposes VITE_* variables, to import.meta.env. Variables already set in
// the environment win.
expand(loadDotenv({ path: join(import.meta.dirname, ".env"), quiet: true }));

const config: Config = {
  appDirectory: "src/app",
  // Server-side render by default. SSR=false builds a SPA instead: a static shell that React Router
  // fills in the browser, without server rendering or server loaders (except the root route's, which
  // runs at build time). server.ts then serves the shell for every page, next to the API.
  // Add `prerender` here to prerender selected paths in either mode.
  ssr: process.env.SSR !== "false",
  // Keep lazy discovery for SSR. Small apps with many programmatic dynamic-path navigations can
  // choose routeDiscovery: { mode: "initial" } to send all route metadata up front (not all code).
  // SPA already uses initial discovery. See README.md for the tradeoffs and validation steps.
  future: {
    // Scan the client entry and route modules before their first imports trigger dependency
    // optimization. Experimental in Router 8.5: recheck cold SSR/SPA development when upgrading.
    unstable_optimizeDeps: true,
  },
};

export default config;
