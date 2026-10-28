import type { Config } from "@react-router/dev/config";

export default {
  appDirectory: "src/app",
  // Server-side render by default. SSR=false builds a SPA instead: a static shell that React Router
  // fills in the browser, without server rendering or server loaders (except the root route's, which
  // runs at build time). Serve build/client from any static host then; `pnpm start` only serves SSR builds.
  // Add `prerender` here to prerender selected paths in either mode.
  ssr: process.env.SSR !== "false",
} satisfies Config;
