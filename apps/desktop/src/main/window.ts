import { createRequire } from "node:module";
import { join } from "node:path";

import { DESKTOP_BOOTSTRAP_ARGUMENT, desktopBootstrapFromArguments, type DesktopBootstrap } from "@repo/shared";
import {
  app,
  Menu,
  BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type Session,
  screen,
  shell,
} from "electron";

import { isAppUrl } from "./app-url.ts";
import type { BootProfile } from "./boot-profile.ts";
import { chromeAppearance, chromeWindowOptions, type ChromePolicy } from "./chrome-policy.ts";
import { installWindowChrome } from "./chrome.ts";
import { redactLogUrls, safeUrl } from "./log-url.ts";
import type { Logger } from "./log.ts";
import type { VisualMirror } from "./visual-mirror.ts";

export const IPC = {
  /** Renderer → main: the preload saw two animation frames, so the page has painted. */
  firstPaint: "desktop:first-paint",
} as const;

export interface WindowOptions {
  session: Session;
  childAppearance?(url: URL): "light" | "dark" | undefined;
  fixedAppearance?: "light" | "dark";
  preloadPath: string;
  appVersion: string;
  log: Logger;
  profile: BootProfile;
  /**
   * Forward the page's console to the main log: in development, so Vite's HMR messages show up, and
   * for the smoke. Never in a release build.
   */
  logRendererConsole?: boolean;
  chrome?: { bootstrap: DesktopBootstrap; currentPolicy: () => ChromePolicy; visualMirror: VisualMirror };
}

const CASCADE_STEP = 24;
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** URL schemes that may be handed to an external application. */
export function isExternalUrl(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
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
    log.warn({ path: safeUrl(url) }, "blocked external URL with a disallowed scheme");
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

/** Chromium constructs renderer-opened windows; the host uses the same native options for its own. */
export function createAppWindow(options: WindowOptions): BrowserWindow {
  return new BrowserWindow({ width: 1200, height: 800, ...nativeOptions(options) });
}

function nativeOptions({ session, preloadPath, chrome, appVersion, fixedAppearance }: WindowOptions) {
  chrome?.visualMirror.retryPending();
  const policy = chrome?.currentPolicy();
  return {
    show: false,
    ...(policy
      ? chromeWindowOptions(
          fixedAppearance
            ? {
                ...policy,
                appearance: { ...chromeAppearance(fixedAppearance === "dark"), height: policy.appearance.height },
                backgroundColor: chromeAppearance(fixedAppearance === "dark").color,
              }
            : policy,
        )
      : { backgroundColor: "#ffffff" }),
    webPreferences: {
      session,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webviewTag: false,
      // Release builds have no DevTools. Every window gets these options, renderer-opened ones too.
      ...(DESKTOP_BUILD_PROFILE === "release" ? { devTools: false } : {}),
      additionalArguments: [
        `--desktop-app-version=${appVersion}`,
        ...(chrome ? [`${DESKTOP_BOOTSTRAP_ARGUMENT}${JSON.stringify({ ...chrome.bootstrap, fixedAppearance })}`] : []),
      ],
    },
  };
}

/**
 * `onShown` runs right after this module shows the window (first paint, or the ready-to-show
 * fallback): on macOS the `show` event follows the window's occlusion state, so while the screen is
 * locked it does not come at all, although the window is shown.
 */
export function configureWindow(
  win: BrowserWindow,
  options: WindowOptions,
  children: {
    reuse(url: string): boolean;
    adopt(window: BrowserWindow, url: string, fixedAppearance?: "light" | "dark"): void;
  },
  onShown?: () => void,
) {
  const { chrome, profile, log, logRendererConsole } = options;
  const policy = chrome?.currentPolicy();
  if (options.fixedAppearance && process.platform === "darwin") {
    const addon = join(app.isPackaged ? process.resourcesPath : __dirname, "window-appearance.node");
    const setAppearance: unknown = createRequire(__filename)(addon);
    if (typeof setAppearance !== "function") throw new Error("Invalid macOS window appearance addon");
    setAppearance(win.getNativeWindowHandle(), options.fixedAppearance === "dark");
  }
  win.webContents.on("context-menu", (_event, params) => {
    if (!params.isEditable && !params.selectionText) return;
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    Menu.buildFromTemplate([
      ...(params.isEditable ? [{ role: "cut" as const, enabled: canCut }] : []),
      { role: "copy", enabled: canCopy },
      ...(params.isEditable ? [{ role: "paste" as const, enabled: canPaste }] : []),
      { type: "separator" },
      { role: "selectAll", enabled: canSelectAll },
    ]).popup({
      window: win,
      frame: params.frame ?? undefined,
      sourceType: params.menuSourceType,
      x: params.x,
      y: params.y,
    });
  });
  if (chrome && policy) {
    installWindowChrome(
      win,
      policy,
      (event) => isTrustedSender(event, win),
      log,
      chrome.visualMirror,
      options.fixedAppearance,
    );
    log.info(
      {
        requestedMode: policy.requestedMode,
        resolvedMode: policy.resolvedMode,
        fallbackReason: policy.fallbackReason,
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
    onShown?.();
  };
  const onFirstPaint = (event: IpcMainEvent) => {
    if (!isTrustedSender(event, win)) return;
    profile.mark("first-paint");
    profile.report();
    show("first-paint");
  };
  win.webContents.ipc.on(IPC.firstPaint, onFirstPaint);
  win.once("ready-to-show", () => setTimeout(() => show("ready-to-show fallback"), 1000));
  win.webContents.once("dom-ready", () => profile.mark("dom-content-loaded"));

  const confine = (details: { preventDefault(): void; url: string }) => {
    if (isAppUrl(details.url)) return;
    details.preventDefault();
    openExternal(details.url, log);
  };
  // Sub-frames too: an <iframe> must not load anything but app://app either (CSP's default-src
  // already blocks other origins; this is the second line). A sub-frame never opens an external app.
  const confineSubframe = (details: { preventDefault(): void; url: string; isMainFrame: boolean }) => {
    if (!details.isMainFrame && !isAppUrl(details.url)) {
      details.preventDefault();
      log.warn({ path: safeUrl(details.url) }, "blocked sub-frame navigation");
    }
  };
  win.webContents.on("will-navigate", confine);
  win.webContents.on("will-redirect", (details) => {
    if (details.isMainFrame) confine(details);
    else confineSubframe(details);
  });
  win.webContents.on("will-frame-navigate", confineSubframe);
  win.webContents.setWindowOpenHandler(({ url, features }) => {
    if (isAppUrl(url)) {
      if (children.reuse(url)) return { action: "deny" };
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const named = new Set(
        features
          .toLowerCase()
          .split(",")
          .map((part) => part.split("=")[0].trim()),
      );
      return {
        action: "allow",
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          ...nativeOptions({ ...options, fixedAppearance: options.childAppearance?.(new URL(url)) }),
          // Leave room to stagger children even when their opener fills the display.
          ...(!named.has("width") &&
            !named.has("innerwidth") && { width: Math.min(bounds.width, Math.max(1, area.width - CASCADE_STEP * 2)) }),
          ...(!named.has("height") &&
            !named.has("innerheight") && {
              height: Math.min(bounds.height, Math.max(1, area.height - CASCADE_STEP * 2)),
            }),
        },
      };
    }
    openExternal(url, log);
    return { action: "deny" };
  });
  let placement = 0;
  win.webContents.on("did-create-window", (child, { url, options: geometry }) => {
    if (geometry.x === undefined || geometry.y === undefined) {
      // At creation Electron has resolved explicit features, including innerWidth and minimum sizes.
      const bounds = win.getBounds();
      const area = screen.getDisplayMatching(bounds).workArea;
      const size = child.getBounds();
      placement++;
      child.setBounds({
        x: geometry.x ?? cascade(bounds.x, size.width, area.x, area.width, placement),
        y: geometry.y ?? cascade(bounds.y, size.height, area.y, area.height, placement),
      });
    }
    const bootstrap = desktopBootstrapFromArguments(geometry.webPreferences?.additionalArguments ?? []);
    children.adopt(child, url, bootstrap?.fixedAppearance);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && details.reason !== "killed") log.error({ details }, "renderer process gone");
  });
  if (logRendererConsole) {
    win.webContents.on("console-message", (event) => {
      if (event.frame !== win.webContents.mainFrame) return;
      log.info({ level: event.level, source: safeUrl(event.sourceId) }, `renderer: ${redactLogUrls(event.message)}`);
    });
  }

  // Reuse must respect the first-paint gate even if the initial URL has already committed.
  return function present() {
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) {
      if (!shown) return;
      win.show();
    }
    win.focus();
  };
}

// Walk the available positions on either side of the opener before reusing one.
function cascade(position: number, size: number, start: number, extent: number, placement: number): number {
  const end = Math.max(start, start + extent - size);
  const origin = Math.max(start, Math.min(position, end));
  const forward = Math.ceil((end - origin) / CASCADE_STEP);
  const backward = Math.ceil((origin - start) / CASCADE_STEP);
  const slot = placement % (1 + forward + backward);
  if (slot <= forward) return Math.min(end, origin + slot * CASCADE_STEP);
  return Math.max(start, origin - (slot - forward) * CASCADE_STEP);
}
