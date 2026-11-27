import { randomUUID } from "node:crypto";

import {
  DESKTOP_CHROME_IPC,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  parseOverlayDeclaration,
  supportsOverlayAppearance,
} from "@repo/shared";
import { type IpcMainEvent, type IpcMainInvokeEvent, nativeTheme, type WebFrameMain } from "electron";

import { chromeAppearance, type ChromePolicy } from "./chrome-policy.ts";
import type { Logger } from "./log.ts";
import type { VisualMirror } from "./visual-mirror.ts";

const STATE_EVENTS = ["focus", "blur", "maximize", "unmaximize", "enter-full-screen", "leave-full-screen"] as const;
interface ChromeWindow extends NodeJS.EventEmitter {
  isDestroyed(): boolean;
  isFocused(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setTitleBarOverlay(appearance: OverlayAppearance): void;
  setBackgroundColor(color: string): void;
  webContents: NodeJS.EventEmitter & { ipc: Pick<Electron.IpcMain, "handle" | "removeHandler" | "on" | "off"> };
}

interface Subscription {
  token: string;
  frame: WebFrameMain;
}

// NativeTheme is process-wide. Window subscriptions last exactly as long as their native chrome.
const themeListeners = new Set<() => void>();
const notifyThemeListeners = () => {
  for (const listener of themeListeners) listener();
};

/** One main-document subscription per window; no renderer-supplied window IDs or arbitrary IPC. */
export function installWindowChrome(
  win: ChromeWindow,
  policy: ChromePolicy,
  trusted: (event: IpcMainEvent | IpcMainInvokeEvent) => boolean,
  log: Logger,
  mirror: VisualMirror,
  fixedAppearance?: "light" | "dark",
): () => void {
  // Electron's webContents getter throws once BrowserWindow is destroyed; retain the emitter for cleanup.
  const contents = win.webContents;
  let subscription: Subscription | undefined;
  let revision = 0;
  let override: OverlayAppearance = {};
  let owner: string | undefined;
  let declarationRevision = 0;
  let visualDocument: string | undefined;
  const getVisualDocument = (event: IpcMainInvokeEvent) => (trusted(event) ? (visualDocument ??= randomUUID()) : null);
  // A child may have been created under an earlier theme. Cache only successful native writes.
  let appearance: OverlayAppearance = {};
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
  const retireDocument = () => {
    clear();
    visualDocument = undefined;
    override = {};
    owner = undefined;
    declarationRevision = 0;
    applyTheme();
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
  const overlayAvailable = supportsOverlayAppearance(policy.platform, policy.resolvedMode);
  const isDark = () => {
    if (fixedAppearance) return fixedAppearance === "dark";
    const preference = mirror.colorScheme();
    return preference === "dark" || (preference === "auto" && nativeTheme.shouldUseDarkColors);
  };
  const applyOverlay = (): OverlayAppearanceResult => {
    if (!overlayAvailable) return { status: "unsupported", reason: "native-overlay-appearance-unavailable" };
    const dark = isDark();
    const merged = { ...policy.appearance, ...chromeAppearance(dark), ...override };
    try {
      if (
        merged.color !== appearance.color ||
        merged.symbolColor !== appearance.symbolColor ||
        merged.height !== appearance.height
      ) {
        // Electron 45 keeps omitted fields on updates. Zero restores system sizing on Windows/Linux.
        win.setTitleBarOverlay(
          appearance.height !== undefined && merged.height === undefined ? { ...merged, height: 0 } : merged,
        );
      }
      appearance = merged;
      return { status: "applied", appearance: { ...appearance } };
    } catch {
      log.warn({}, "window overlay appearance update failed");
      return { status: "rejected", reason: "native-update-failed" };
    }
  };
  const applyTheme = () => {
    if (win.isDestroyed()) return;
    try {
      win.setBackgroundColor(chromeAppearance(isDark()).color);
    } catch {
      log.warn({}, "window background update failed");
    }
    applyOverlay();
  };
  const declareAppearance = (event: IpcMainInvokeEvent, input: unknown): OverlayAppearanceResult => {
    if (!trusted(event)) return { status: "rejected", reason: "untrusted-sender" };
    if (
      typeof input !== "object" ||
      input === null ||
      !("document" in input) ||
      typeof input.document !== "string" ||
      !/^[\w-]{1,80}$/.test(input.document) ||
      !("declaration" in input)
    )
      return { status: "rejected", reason: "invalid-appearance" };
    if (input.document !== visualDocument) return { status: "rejected", reason: "stale-document" };
    const next = parseOverlayDeclaration(input.declaration);
    if (!next) return { status: "rejected", reason: "invalid-appearance" };
    if (next.revision <= declarationRevision) return { status: "rejected", reason: "stale-declaration" };
    if (next.appearance !== null && owner !== undefined && owner !== next.owner)
      return { status: "rejected", reason: "appearance-owner-conflict" };
    declarationRevision = next.revision;
    if (next.appearance !== null) {
      owner = next.owner;
      override = next.appearance;
    } else if (owner === next.owner) {
      owner = undefined;
      override = {};
    }
    return applyOverlay();
  };
  const releaseTheme = mirror.onColorSchemeChange(applyTheme);
  const themeChanged = () => {
    if (!win.isDestroyed() && mirror.colorScheme() === "auto") applyTheme();
  };
  if (themeListeners.size === 0) nativeTheme.on("updated", notifyThemeListeners);
  themeListeners.add(themeChanged);
  contents.ipc.handle(DESKTOP_CHROME_IPC.visualDocument, getVisualDocument);
  contents.ipc.handle(DESKTOP_CHROME_IPC.declaration, declareAppearance);
  contents.ipc.handle(DESKTOP_CHROME_IPC.subscribe, subscribe);
  contents.ipc.on(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
  for (const event of STATE_EVENTS) win.on(event, refresh);
  contents.on("did-navigate", retireDocument);
  contents.on("render-process-gone", retireDocument);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;

    clear();
    releaseTheme();
    themeListeners.delete(themeChanged);
    if (themeListeners.size === 0) nativeTheme.off("updated", notifyThemeListeners);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.visualDocument);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.subscribe);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.declaration);
    contents.ipc.off(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
    for (const event of STATE_EVENTS) win.off(event, refresh);
    contents.off("did-navigate", retireDocument);
    contents.off("render-process-gone", retireDocument);
    win.off("closed", dispose);
  };
  win.once("closed", dispose);

  return dispose;
}
