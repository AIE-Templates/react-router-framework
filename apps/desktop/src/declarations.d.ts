// Global declarations (a script file, not a module, so these apply everywhere in the package).

/** The `react-router dev` address, defined by the Vite build in development; `undefined` in a production build. */
declare const DESKTOP_DEV_SERVER_URL: string | undefined;

interface Window {
  /** What the preload script exposes to pages running in the desktop shell. */
  desktop?: import("@repo/shared").DesktopBridge;
}
