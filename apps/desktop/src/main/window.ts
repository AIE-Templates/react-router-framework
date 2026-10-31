import { DESKTOP_BOOTSTRAP_ARGUMENT, type DesktopBootstrap } from "@repo/shared";
import { BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, type Session, shell } from "electron";

import type { BootProfile } from "./boot-profile.ts";
import { chromeWindowOptions, type ChromePolicy } from "./chrome-policy.ts";
import { installWindowChrome } from "./chrome.ts";
import type { Logger } from "./log.ts";
import type { VisualThemeStore } from "./visual-theme.ts";

export const IPC = {
  /** Renderer → main: the preload saw two animation frames, so the page has painted. */
  firstPaint: "desktop:first-paint",
} as const;

export interface MainWindowOptions {
  session: Session;
  preloadPath: string;
  appVersion: string;
  log: Logger;
  profile: BootProfile;
  /** Development: forward the page's console to the main log, so Vite's HMR messages show up. */
  logRendererConsole?: boolean;
  chrome?: { bootstrap: DesktopBootstrap; policy: ChromePolicy; visualThemeStore?: VisualThemeStore };
}

const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** What `createWindowKeeper()` needs of a window. */
export interface KeptWindow {
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
}

export interface WindowKeeper<W extends KeptWindow> {
  /** The live window, or `undefined` once it was closed or destroyed. */
  current(): W | undefined;
  /** The live window, or a new one from `create` (with its `closed` bookkeeping) when there is none. */
  open(): { window: W; created: boolean };
}

/**
 * Keeps the reference to the single main window straight across close and reopen: every window
 * made through `open()` clears the reference when it closes, and only if it is still the one held,
 * so a window created on `activate` is tracked like the first one.
 */
export function createWindowKeeper<W extends KeptWindow>(create: () => W): WindowKeeper<W> {
  let held: W | undefined;
  const current = () => (held && !held.isDestroyed() ? held : undefined);
  return {
    current,
    open() {
      const existing = current();
      if (existing) return { window: existing, created: false };
      const window = create();
      held = window;
      window.once("closed", () => {
        if (held === window) held = undefined;
      });
      return { window, created: true };
    },
  };
}

export function isAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "app:" && parsed.host === "app";
  } catch {
    return false;
  }
}

/** The scheme, host and path of `url` for logs; never the query string (AGENTS: it can carry tokens). */
export function safePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "(invalid URL)";
  }
}

/** Opens `url` in the system browser if it is a web or mail link; anything else is dropped. */
export function openExternal(url: string, log: Logger): void {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return;
  }
  if (!EXTERNAL_SCHEMES.has(protocol)) {
    log.warn({ path: safePath(url) }, "blocked external URL with a disallowed scheme");
    return;
  }
  void shell.openExternal(url);
}

/**
 * Whether an IPC message comes from the app window's main frame on `app://app`. Compare the
 * protocol and host, never `origin`: a non-special scheme's origin serializes as "null".
 */
export function isTrustedSender(event: IpcMainEvent | IpcMainInvokeEvent, win: BrowserWindow | undefined): boolean {
  const frame = event.senderFrame;
  if (!win || win.isDestroyed() || !frame || event.sender !== win.webContents || frame !== win.webContents.mainFrame)
    return false;
  return isAppUrl(frame.url);
}

/**
 * The app window: sandboxed renderer on a dedicated session, shown on first paint, confined to
 * `app://app` (other navigations and new windows go to the system browser).
 */
export function createMainWindow({
  session,
  preloadPath,
  appVersion,
  log,
  profile,
  logRendererConsole,
  chrome,
}: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    ...(chrome ? chromeWindowOptions(chrome.policy) : { backgroundColor: "#ffffff" }),
    webPreferences: {
      session,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      additionalArguments: [
        `--desktop-app-version=${appVersion}`,
        ...(chrome ? [`${DESKTOP_BOOTSTRAP_ARGUMENT}${JSON.stringify(chrome.bootstrap)}`] : []),
      ],
    },
  });

  if (chrome) {
    installWindowChrome(win, chrome.policy, (event) => isTrustedSender(event, win), log, chrome.visualThemeStore);
    log.info(
      {
        requestedMode: chrome.policy.requestedMode,
        resolvedMode: chrome.policy.resolvedMode,
        fallbackReason: chrome.policy.fallbackReason,
      },
      "window chrome policy",
    );
  }

  let shown = false;
  const show = (reason: string) => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    log.debug({ reason }, "showing window");
    win.show();
  };
  const onFirstPaint = (event: IpcMainEvent) => {
    if (!isTrustedSender(event, win)) return;
    profile.mark("first-paint");
    profile.report();
    show("first-paint");
  };
  ipcMain.on(IPC.firstPaint, onFirstPaint);
  win.once("ready-to-show", () => setTimeout(() => show("ready-to-show fallback"), 1000));
  win.webContents.once("dom-ready", () => profile.mark("dom-content-loaded"));
  win.once("closed", () => ipcMain.off(IPC.firstPaint, onFirstPaint));

  const confine = (event: { preventDefault(): void }, url: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url, log);
  };
  win.webContents.on("will-navigate", confine);
  win.webContents.on("will-redirect", confine);
  // Sub-frames too: an <iframe> must not load anything but app://app either (CSP's default-src
  // already blocks other origins; this is the second line).
  win.webContents.on("will-frame-navigate", (details) => {
    if (!details.isMainFrame && !isAppUrl(details.url)) {
      details.preventDefault();
      log.warn({ path: safePath(details.url) }, "blocked sub-frame navigation");
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url, log);
    return { action: "deny" };
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && details.reason !== "killed") log.error({ details }, "renderer process gone");
  });
  if (logRendererConsole) {
    win.webContents.on("console-message", (event) =>
      log.info({ level: event.level, source: event.sourceId }, `renderer: ${event.message}`),
    );
  }
  return win;
}
