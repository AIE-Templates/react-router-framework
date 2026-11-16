import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src/app",
  // Server-side render by default. SSR=false builds a SPA instead: a static shell that React Router
  // fills in the browser, without server rendering or server loaders (except the root route's, which
  // runs at build time). Serve build/client from any static host then; `pnpm start` only serves SSR builds.
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
} satisfies Config;
