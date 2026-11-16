import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src/app",
  // A static SPA: React Router prebuilds a shell (build/client/index.html) and fills it in the browser,
  // without server rendering or server loaders (except the root route's, which runs at build time).
  // Deploy build/client to any static host that falls back to index.html for unknown paths.
  // Add `prerender` here to prerender selected paths; index.html is then the prerendered home page
  // and the shell is __spa-fallback.html, which the host must fall back to instead (nginx/default.conf
  // already does; `pnpm start` does not).
  ssr: false,
  // Keep lazy discovery for SSR. Small apps with many programmatic dynamic-path navigations can
  // choose routeDiscovery: { mode: "initial" } to send all route metadata up front (not all code).
  // SPA already uses initial discovery. See README.md for the tradeoffs and validation steps.
  future: {
    // Scan the client entry and route modules before their first imports trigger dependency
    // optimization. Experimental in Router 8.5: recheck cold SSR/SPA development when upgrading.
    unstable_optimizeDeps: true,
  },
} satisfies Config;
