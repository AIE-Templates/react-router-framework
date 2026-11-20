import { builtinModules } from "node:module";

import { defaultServerConditions, type UserConfig } from "vite";

import { BUILD_PROFILE_ENV, type BuildProfile, buildProfileFrom, bundleDir } from "./scripts/build-profile.ts";

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
 * One Vite lib build per entry, the way the Electron Forge Vite template does it, for one build
 * profile (scripts/build-profile.ts; DESKTOP_BUILD_PROFILE, `test` when unset): output in
 * `.vite/<profile>`, the profile compiled in as DESKTOP_BUILD_PROFILE. The dev profile is unminified
 * and leaves NODE_ENV to the runtime; test and release are minified and replace NODE_ENV so
 * dependencies such as React select their production branches. Watch mode (`DESKTOP_WATCH=1`, while
 * `scripts/dev.ts` runs) is dev-only, and only watch builds embed the development server address.
 */
export function entryConfig(
  { entry, fileName, format }: EntryOptions,
  profile: BuildProfile = buildProfileFrom(process.env[BUILD_PROFILE_ENV]),
): UserConfig {
  const watch = process.env.DESKTOP_WATCH === "1";
  if (watch && profile !== "dev") throw new Error(`Watch builds use the dev profile, not ${profile}`);
  const development = profile === "dev";
  const devServerUrl = watch ? process.env.DESKTOP_DEV_SERVER_URL : undefined;
  return {
    publicDir: false,
    define: {
      DESKTOP_BUILD_PROFILE: JSON.stringify(profile satisfies typeof DESKTOP_BUILD_PROFILE),
      DESKTOP_DEV_SERVER_URL: devServerUrl ? JSON.stringify(devServerUrl) : "undefined",
      ...(!development ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
    },
    resolve: {
      // Workspace packages from source; Node's own export conditions, not the browser's, so
      // packages such as react-dom/server resolve to their Node builds.
      conditions: ["@repo/source", ...defaultServerConditions],
      mainFields: ["module", "main"],
      tsconfigPaths: true,
    },
    build: {
      outDir: bundleDir(profile),
      emptyOutDir: false,
      minify: !development,
      sourcemap: true,
      watch: watch ? {} : null,
      lib: { entry, formats: [format], fileName: () => fileName },
      rollupOptions: { external, platform: "node", output: { codeSplitting: false } },
    },
    clearScreen: false,
  };
}
