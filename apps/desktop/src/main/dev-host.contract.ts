import type { PortFetch } from "@repo/port-fetch";

// What src/main.ts uses of the development-only code, and the only way it reaches it:
// `~/main/dev-host.ts` in the dev build, `~/main/dev-host.empty.ts` in its place in test and release
// builds (vite.base.config.ts). Types only, so this file is in no bundle.

/** What the dev build has instead of a utility process: `react-router dev`, started by scripts/dev.ts. */
export interface DevelopmentHost {
  /** The dev server's origin, which pages come from (DESKTOP_DEV_SERVER_URL, compiled in). */
  serverUrl: string;
  /** Forwards `app://` requests to the dev server (src/main/dev-proxy.ts). */
  createFetch(): PortFetch;
  /** Calls `reload` whenever scripts/dev.ts reports a rebuilt preload script. */
  onReloadRequest(reload: () => void): void;
  /**
   * `DESKTOP_USER_DATA_SUFFIX`, as it was when the process started: a userData directory of its own,
   * apart from the installed app's (src/main/user-data.ts). scripts/dev.ts sets it, `dev` by default.
   */
  userDataSuffix: string | undefined;
}

/** The dev build's host; undefined in every other build, which is how the main process tells. */
export type DevelopmentHostOrNone = DevelopmentHost | undefined;
