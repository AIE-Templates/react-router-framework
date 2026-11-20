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

/** The bundles of one profile, in `.vite/<profile>`: the main process, the preload script, the utility process. */
export const BUNDLES = ["main.cjs", "preload.cjs", "utility.mjs"] as const;
export type Bundle = (typeof BUNDLES)[number];

/** A record with one value per bundle. */
export function perBundle<T>(value: (bundle: Bundle) => T): Record<Bundle, T> {
  return { "main.cjs": value("main.cjs"), "preload.cjs": value("preload.cjs"), "utility.mjs": value("utility.mjs") };
}

/**
 * A source module only some profiles bundle. In the others the build puts `empty`, an implementation
 * of the same contract that does nothing, in its place (`resolve.alias` in vite.base.config.ts), so
 * neither `module` nor what only it imports (`owns`) is in their bundles. That is decided by the
 * build configuration, not left to tree-shaking, and scripts/verify-build.ts checks the result
 * against the bundler's own module lists. Paths are relative to apps/desktop.
 */
export interface ProfileEntry {
  /** How source imports the module; it must be exactly this, since the alias matches the specifier. */
  specifier: string;
  module: string;
  empty: string;
  /** The profiles that bundle `module`; the rest bundle `empty`. */
  profiles: readonly BuildProfile[];
  /** Source that reaches a bundle only through `module`: files, or directories with a trailing slash. */
  owns: readonly string[];
  /** The bundles that import the entry. */
  bundles: readonly Bundle[];
}

export const PROFILE_ENTRIES: readonly ProfileEntry[] = [
  {
    // The debug environment variables: read in dev and test, not even named in release.
    specifier: "~/debug-env.ts",
    module: "src/debug-env.ts",
    empty: "src/debug-env.empty.ts",
    profiles: ["dev", "test"],
    owns: ["src/debug-env.names.ts"],
    bundles: ["main.cjs", "utility.mjs"],
  },
  {
    // The smoke, the benchmark and the end-to-end endpoints.
    specifier: "~/diagnostics/entry.ts",
    module: "src/diagnostics/entry.ts",
    empty: "src/diagnostics/entry.empty.ts",
    profiles: ["dev", "test"],
    owns: ["src/diagnostics/"],
    bundles: ["main.cjs", "utility.mjs"],
  },
  {
    // The development server proxy and preload reload.
    specifier: "~/main/dev-host.ts",
    module: "src/main/dev-host.ts",
    empty: "src/main/dev-host.empty.ts",
    profiles: ["dev"],
    owns: ["src/main/dev-proxy.ts"],
    bundles: ["main.cjs"],
  },
];

/** The entries whose `empty` implementation `profile` bundles. */
export function emptyEntries(profile: BuildProfile): ProfileEntry[] {
  return PROFILE_ENTRIES.filter((entry) => !entry.profiles.includes(profile));
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
