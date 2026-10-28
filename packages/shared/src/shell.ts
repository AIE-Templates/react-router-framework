/** Operating systems the desktop shell runs on, as Node.js reports them in `process.platform`. */
export const DESKTOP_PLATFORMS = ["darwin", "win32", "linux"] as const;

export type DesktopPlatform = (typeof DESKTOP_PLATFORMS)[number];

/**
 * Where the web app runs, decided by its entry point and fixed for the life of the process: the
 * desktop shell's entry passes `{ kind: "desktop", ... }` once, every other entry nothing (`web`).
 * Never derived from a request.
 */
export type Shell =
  | { kind: "web" }
  | {
      kind: "desktop";
      platform: DesktopPlatform;
      /** The OS version, e.g. `26.1` on macOS or `10.0.26100` on Windows. */
      osVersion: string;
      /** Linux only: the desktop environment, e.g. `GNOME` (`XDG_CURRENT_DESKTOP`). */
      desktopEnv?: string;
      /** Linux only: `wayland` or `x11` (`XDG_SESSION_TYPE`). */
      sessionType?: string;
    };

export const WEB_SHELL: Shell = Object.freeze({ kind: "web" });

/**
 * The shell described by environment variables, for entries that are started by another process
 * rather than called with options: the desktop dev script starts `react-router dev` with
 * `WEB_SHELL=desktop`, `WEB_SHELL_PLATFORM` (`darwin`, `win32` or `linux`), `WEB_SHELL_OS_VERSION`
 * and optionally `WEB_SHELL_DESKTOP_ENV` and `WEB_SHELL_SESSION_TYPE`. Anything else, an unknown
 * platform included, is the web shell.
 */
export function shellFromEnv(env: Record<string, string | undefined>): Shell {
  const platform = env.WEB_SHELL_PLATFORM;
  if (env.WEB_SHELL !== "desktop" || !isDesktopPlatform(platform)) return WEB_SHELL;
  return {
    kind: "desktop",
    platform,
    osVersion: env.WEB_SHELL_OS_VERSION ?? "",
    ...(env.WEB_SHELL_DESKTOP_ENV ? { desktopEnv: env.WEB_SHELL_DESKTOP_ENV } : {}),
    ...(env.WEB_SHELL_SESSION_TYPE ? { sessionType: env.WEB_SHELL_SESSION_TYPE } : {}),
  };
}

function isDesktopPlatform(value: string | undefined): value is DesktopPlatform {
  return (DESKTOP_PLATFORMS as readonly (string | undefined)[]).includes(value);
}
