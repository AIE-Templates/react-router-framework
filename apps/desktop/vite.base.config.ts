import { builtinModules } from "node:module";

import { defaultServerConditions, type UserConfig } from "vite";

/** Left to the runtime: Electron itself and Node's built-in modules. Everything else is bundled. */
export const external = [
  "electron",
  "electron/main",
  "electron/renderer",
  ...builtinModules.flatMap((m) => [m, `node:${m}`]),
];

export interface EntryOptions {
  entry: string;
  fileName: string;
  format: "cjs" | "es";
}

/**
 * One Vite lib build per entry, the way the Electron Forge Vite template does it: output in
 * `.vite/build`, minified for a real build, in watch mode while `scripts/dev.ts` runs
 * (`DESKTOP_WATCH=1`). Only watch builds embed the development server address; ordinary library
 * builds also replace NODE_ENV so dependencies such as React select their production branches.
 */
export function entryConfig({ entry, fileName, format }: EntryOptions): UserConfig {
  const watch = process.env.DESKTOP_WATCH === "1";
  const devServerUrl = watch ? process.env.DESKTOP_DEV_SERVER_URL : undefined;
  return {
    publicDir: false,
    define: {
      DESKTOP_DEV_SERVER_URL: devServerUrl ? JSON.stringify(devServerUrl) : "undefined",
      ...(!watch ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
    },
    resolve: {
      // Workspace packages from source; Node's own export conditions, not the browser's, so
      // packages such as react-dom/server resolve to their Node builds.
      conditions: ["@repo/source", ...defaultServerConditions],
      mainFields: ["module", "main"],
      tsconfigPaths: true,
    },
    build: {
      outDir: ".vite/build",
      emptyOutDir: false,
      minify: !watch,
      sourcemap: true,
      watch: watch ? {} : null,
      lib: { entry, formats: [format], fileName: () => fileName },
      rollupOptions: { external, platform: "node", output: { codeSplitting: false } },
    },
    clearScreen: false,
  };
}
