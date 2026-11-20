import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultServerConditions, type UserConfig } from "vite";

import {
  BUILD_PROFILE_ENV,
  type BuildProfile,
  buildProfileFrom,
  bundleDir,
  emptyEntries,
} from "./scripts/build-profile.ts";
import { recordBundleModules } from "./scripts/bundle-modules.ts";

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

/** apps/desktop, where this file is. */
const desktopDir = fileURLToPath(new URL(".", import.meta.url));

/**
 * The `resolve.alias` entries of one profile: every source module the profile does not bundle
 * (PROFILE_ENTRIES in scripts/build-profile.ts) resolves to its empty implementation. The match is on
 * the import specifier, exactly as source writes it.
 */
export function emptyEntryAliases(profile: BuildProfile): { find: RegExp; replacement: string }[] {
  return emptyEntries(profile).map((entry) => ({
    find: new RegExp(`^${entry.specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    replacement: resolve(desktopDir, entry.empty),
  }));
}

/**
 * One Vite lib build per entry, the way the Electron Forge Vite template does it, for one build
 * profile (scripts/build-profile.ts; DESKTOP_BUILD_PROFILE, `test` when unset): output in
 * `.vite/<profile>`, the profile compiled in as DESKTOP_BUILD_PROFILE. Everything that differs
 * between profiles follows from the profile alone:
 * - dev is unminified, leaves NODE_ENV to the runtime, is always a watch build and embeds the
 *   development server address, which it therefore requires (DESKTOP_DEV_SERVER_URL; scripts/dev.ts
 *   sets it, and is the only build of this profile);
 * - test and release are minified and replace NODE_ENV so dependencies such as React select their
 *   production branches;
 * - the source modules a profile does not bundle are replaced by empty implementations
 *   (`emptyEntryAliases`): the development host outside dev; the diagnostics and the debug
 *   environment variables in release.
 * Each bundle's module list is recorded beside it for scripts/verify-build.ts.
 */
export function entryConfig(
  { entry, fileName, format }: EntryOptions,
  profile: BuildProfile = buildProfileFrom(process.env[BUILD_PROFILE_ENV]),
): UserConfig {
  const development = profile === "dev";
  const devServerUrl = development ? process.env.DESKTOP_DEV_SERVER_URL : undefined;
  if (development && !devServerUrl) {
    throw new Error("The dev profile is built by scripts/dev.ts only: it needs DESKTOP_DEV_SERVER_URL");
  }
  return {
    publicDir: false,
    define: {
      DESKTOP_BUILD_PROFILE: JSON.stringify(profile satisfies typeof DESKTOP_BUILD_PROFILE),
      DESKTOP_DEV_SERVER_URL: devServerUrl ? JSON.stringify(devServerUrl) : "undefined",
      ...(!development ? { "process.env.NODE_ENV": JSON.stringify("production") } : {}),
    },
    resolve: {
      alias: emptyEntryAliases(profile),
      // Workspace packages from source; Node's own export conditions, not the browser's, so
      // packages such as react-dom/server resolve to their Node builds.
      conditions: ["@repo/source", ...defaultServerConditions],
      mainFields: ["module", "main"],
      tsconfigPaths: true,
    },
    plugins: [recordBundleModules(profile, desktopDir)],
    build: {
      outDir: bundleDir(profile),
      emptyOutDir: false,
      minify: !development,
      sourcemap: true,
      watch: development ? {} : null,
      lib: { entry, formats: [format], fileName: () => fileName },
      rollupOptions: { external, platform: "node", output: { codeSplitting: false } },
    },
    clearScreen: false,
  };
}
