import { join } from "node:path";

import type { Config } from "@react-router/dev/config";
import { config as loadDotenv } from "dotenv";
import { expand } from "dotenv-expand";

// Load .env, if any, for `react-router dev` and `react-router build`: this file is the first thing they
// load, so this config and server code (through Vite) see the same variables as server.ts does in
// production. Vite itself only exposes VITE_* variables, to import.meta.env. Variables already set in
// the environment win.
expand(loadDotenv({ path: join(import.meta.dirname, ".env"), quiet: true }));

export default {
  appDirectory: "src/app",
  // Server-side render by default. SSR=false builds a SPA instead: a static shell that React Router
  // fills in the browser, without server rendering or server loaders (except the root route's, which
  // runs at build time). server.ts then serves the shell for every page, next to the API.
  // Add `prerender` here to prerender selected paths in either mode.
  ssr: process.env.SSR !== "false",
} satisfies Config;
