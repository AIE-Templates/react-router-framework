import {
  DESKTOP_CHROME_IPC,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  parseOverlayAppearance,
} from "@repo/shared";
import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain, nativeTheme, type WebFrameMain } from "electron";

import { chromeAppearance, type ChromePolicy } from "./chrome-policy.ts";
import type { Logger } from "./log.ts";

// The shell owns one current window. A late close from an old window cannot remove its successor's IPC handlers.
let installedCleanup: (() => void) | undefined;

const STATE_EVENTS = ["focus", "blur", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const;
interface ChromeWindow extends NodeJS.EventEmitter {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setTitleBarOverlay(appearance: OverlayAppearance): void;
  setBackgroundColor(color: string): void;
  webContents: NodeJS.EventEmitter;
}

interface Subscription {
  token: string;
  frame: WebFrameMain;
}

/** One main-document subscription per window; no renderer-supplied window IDs or arbitrary IPC. */
export function installWindowChrome(
  win: ChromeWindow,
  policy: ChromePolicy,
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  log: Logger,
): () => void {
  installedCleanup?.();
  // Electron's webContents getter throws once BrowserWindow is destroyed; retain the emitter for cleanup.
  const contents = win.webContents;
  let subscription: Subscription | undefined;
  let revision = 0;
  let callerOwnsColors = false;
  let appearance: OverlayAppearance = { ...policy.appearance };
  const read = (): DesktopWindowState => ({
    revision,
    focused: win.isFocused(),
    maximized: win.isMaximized(),
    fullscreen: win.isFullScreen(),
  });
  let state = read();
  const refresh = () => {
    if (win.isDestroyed()) return;
    const next = read();
    if (state.focused === next.focused && state.maximized === next.maximized && state.fullscreen === next.fullscreen)
      return;
    state = { ...next, revision: ++revision };
    if (subscription && !subscription.frame.detached) {
      try {
        subscription.frame.send(DESKTOP_CHROME_IPC.state, { token: subscription.token, state });
      } catch {
        subscription = undefined;
      }
    }
  };
  const clear = () => {
    subscription = undefined;
  };
  const navigate = (_event: unknown, _url: string, inPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !inPlace) clear();
  };
  const subscribe = (event: IpcMainInvokeEvent, token: unknown) => {
    if (!trusted(event) || typeof token !== "string" || !/^[\w-]{1,80}$/.test(token)) return null;
    refresh();
    subscription = { token, frame: event.senderFrame! };
    return { token, state };
  };
  const unsubscribe = (event: IpcMainEvent, token: unknown) => {
    const active = subscription;
    if (trusted(event) && active && active.token === token && active.frame === event.senderFrame) clear();
  };
  const updateAppearance = (event: IpcMainInvokeEvent, input: unknown): OverlayAppearanceResult => {
    if (!trusted(event)) return { status: "rejected", reason: "untrusted-sender" };
    const next = parseOverlayAppearance(input);
    if (!next) return { status: "rejected", reason: "invalid-appearance" };
    if (policy.resolvedMode !== "native-overlay" || policy.platform === "darwin")
      return { status: "unsupported", reason: "native-overlay-appearance-unavailable" };
    const merged = { ...appearance, ...next };
    if (
      merged.color !== appearance.color ||
      merged.symbolColor !== appearance.symbolColor ||
      merged.height !== appearance.height
    ) {
      try {
        win.setTitleBarOverlay(merged);
        if (next.color !== undefined && next.color !== appearance.color) win.setBackgroundColor(next.color);
        appearance = merged;
      } catch {
        log.warn({}, "window overlay appearance update failed");
        return { status: "rejected", reason: "native-update-failed" };
      }
    }
    if (next.color !== undefined || next.symbolColor !== undefined) callerOwnsColors = true;
    return { status: "applied", appearance: { ...appearance } };
  };
  const themeChanged = () => {
    if (win.isDestroyed() || callerOwnsColors) return;
    const next = chromeAppearance(nativeTheme.shouldUseDarkColors);
    win.setBackgroundColor(next.color);
    if (policy.resolvedMode === "native-overlay" && policy.platform !== "darwin") {
      try {
        const merged = { ...appearance, color: next.color, symbolColor: next.symbolColor };
        win.setTitleBarOverlay(merged);
        appearance = merged;
      } catch {
        log.warn({}, "system window overlay appearance update failed");
      }
    }
  };
  if (policy.followsSystemTheme) nativeTheme.on("updated", themeChanged);
  ipcMain.handle(DESKTOP_CHROME_IPC.subscribe, subscribe);
  ipcMain.handle(DESKTOP_CHROME_IPC.appearance, updateAppearance);
  ipcMain.on(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
  for (const event of STATE_EVENTS) win.on(event, refresh);
  contents.on("did-start-navigation", navigate);
  contents.on("render-process-gone", clear);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (installedCleanup === dispose) installedCleanup = undefined;
    clear();
    if (policy.followsSystemTheme) nativeTheme.off("updated", themeChanged);
    ipcMain.removeHandler(DESKTOP_CHROME_IPC.subscribe);
    ipcMain.removeHandler(DESKTOP_CHROME_IPC.appearance);
    ipcMain.off(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
    for (const event of STATE_EVENTS) win.off(event, refresh);
    contents.off("did-start-navigation", navigate);
    contents.off("render-process-gone", clear);
    win.off("closed", dispose);
  };
  win.once("closed", dispose);
  installedCleanup = dispose;
  return dispose;
}
