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
