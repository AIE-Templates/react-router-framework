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
} satisfies Config;
