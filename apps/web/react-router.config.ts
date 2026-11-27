import type { Config } from "@react-router/dev/config";

const config: Config = {
  appDirectory: "src/app",
  // A static SPA: React Router prebuilds a shell (build/client/index.html) and fills it in the browser,
  // without server rendering or server loaders (except the root route's, which runs at build time).
  // Deploy build/client to any static host that falls back to index.html for unknown paths.
  // Add `prerender` here to prerender selected paths; index.html is then the prerendered home page
  // and the shell is __spa-fallback.html. Both the Hono entry and nginx use that fallback.
  ssr: false,
  // Static SPA builds already use initial route discovery; do not force lazy discovery here.
  future: {
    // Scan the client entry and route modules before their first imports trigger dependency
    // optimization. Experimental in Router 8.5: recheck cold development startup when upgrading.
    unstable_optimizeDeps: true,
  },
};

export default config;
