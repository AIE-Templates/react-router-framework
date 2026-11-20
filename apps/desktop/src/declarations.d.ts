// Global declarations (a script file, not a module, so these apply everywhere in the package).

/**
 * The build profile these bundles were built with (scripts/build-profile.ts), defined by the Vite
 * build (vite.base.config.ts) and, for unit tests importing source, by vitest.config.ts as `test`.
 */
declare const DESKTOP_BUILD_PROFILE: "dev" | "test" | "release";

/**
 * The main process's build profile for the Playwright fixtures (e2e/desktop.ts), which evaluate it in
 * the main process; set by src/main.ts in dev and test builds, never in release builds.
 */
declare var desktopBuildProfile: "dev" | "test" | undefined;

/** The `react-router dev` address, defined by the Vite build in development; `undefined` in a production build. */
declare const DESKTOP_DEV_SERVER_URL: string | undefined;

interface Window {
  /** What the preload script exposes to pages running in the desktop shell. */
  desktop?: import("@repo/shared").DesktopBridge;
}
