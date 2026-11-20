// The desktop build profiles, shared by the build entry (scripts/build.ts), the Vite configuration
// (vite.base.config.ts), development (scripts/dev.ts) and the launchers (scripts/launch.ts):
// - `dev`: `pnpm dev:desktop` only, always in watch mode; unminified, NODE_ENV left to the runtime;
// - `test`: `pnpm build:desktop` and `pnpm package:desktop`, what Playwright, the smoke and the bench run;
// - `release`: `pnpm release:desktop` and `pnpm dist:desktop`, the distributed build.
// Each profile has its own bundle directory (`.vite/<profile>`), so a launcher can never pick up
// another profile's bundles, and the main process reports the profile it was built with in its
// first log line. Dependency-free and erasable TypeScript: plain Node imports this file.

export const BUILD_PROFILES = ["dev", "test", "release"] as const;
export type BuildProfile = (typeof BUILD_PROFILES)[number];

/** What a build without an explicit profile produces (`pnpm -r build` calls `build.ts` bare). */
export const DEFAULT_BUILD_PROFILE: BuildProfile = "test";

/** How scripts/build.ts tells the Vite configuration which profile to build. */
export const BUILD_PROFILE_ENV = "DESKTOP_BUILD_PROFILE";

export function isBuildProfile(value: unknown): value is BuildProfile {
  return typeof value === "string" && BUILD_PROFILES.some((profile) => profile === value);
}

/** The profile named by `value` (DESKTOP_BUILD_PROFILE), `test` when unset; anything else throws. */
export function buildProfileFrom(value: string | undefined): BuildProfile {
  if (value === undefined || value === "") return DEFAULT_BUILD_PROFILE;
  if (!isBuildProfile(value)) {
    throw new Error(`Unknown desktop build profile ${JSON.stringify(value)}: expected ${BUILD_PROFILES.join(", ")}`);
  }
  return value;
}

/** A profile's bundle directory, relative to apps/desktop. */
export function bundleDir(profile: BuildProfile): string {
  return `.vite/${profile}`;
}

export type BuildMode = "desktop" | "with-web" | "workspace";

/** What scripts/build.ts builds; the dev profile is built only by scripts/dev.ts, in watch mode. */
export type BuildCommandProfile = Exclude<BuildProfile, "dev">;

export const BUILD_USAGE = "Usage: build.ts [test | release] [--with-web] | build.ts --workspace";

/**
 * Parses scripts/build.ts's arguments: an optional `test` or `release` and an optional `--with-web`,
 * in either order, or `--workspace` alone (the recursive build runs each package's own `build`, the
 * desktop's with the default profile).
 */
export function parseBuildArgs(args: readonly string[]): { profile: BuildCommandProfile; mode: BuildMode } {
  let profile: BuildCommandProfile | undefined;
  let mode: BuildMode | undefined;
  for (const arg of args) {
    if ((arg === "test" || arg === "release") && profile === undefined) profile = arg;
    else if (arg === "--with-web" && mode === undefined) mode = "with-web";
    else if (arg === "--workspace" && mode === undefined) mode = "workspace";
    else throw new Error(BUILD_USAGE);
  }
  if (mode === "workspace" && profile !== undefined) throw new Error(BUILD_USAGE);
  return { profile: profile ?? "test", mode: mode ?? "desktop" };
}
