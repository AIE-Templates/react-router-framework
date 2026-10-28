import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src/app",
  // A static SPA: React Router prebuilds a shell (build/client/index.html) and fills it in the browser,
  // without server rendering or server loaders (except the root route's, which runs at build time).
  // Deploy build/client to any static host that falls back to index.html for unknown paths.
  // Add `prerender` here to prerender selected paths.
  ssr: false,
} satisfies Config;
