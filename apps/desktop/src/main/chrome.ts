import { randomUUID } from "node:crypto";

import {
  DESKTOP_CHROME_IPC,
  type DesktopWindowState,
  type OverlayAppearance,
  type OverlayAppearanceResult,
  parseOverlayAppearance,
  parseOverlayDeclaration,
  isVisualThemePreference,
  type VisualThemeResult,
} from "@repo/shared";
import { type IpcMainEvent, type IpcMainInvokeEvent, nativeTheme, type WebFrameMain } from "electron";

import { chromeAppearance, type ChromePolicy } from "./chrome-policy.ts";
import type { Logger } from "./log.ts";
import type { VisualThemeStore } from "./visual-theme.ts";

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
  themeStore?: VisualThemeStore,
): () => void {
  // Electron's webContents getter throws once BrowserWindow is destroyed; retain the emitter for cleanup.
  const contents = win.webContents;
  let subscription: Subscription | undefined;
  let revision = 0;
  let preference = policy.themePreference;
  let override: OverlayAppearance = {};
  let owner: string | undefined;
  let declarationRevision = 0;
  let themeRevision = 0;
  let visualDocument: string | undefined;
  const getVisualDocument = (event: IpcMainInvokeEvent) => (trusted(event) ? (visualDocument ??= randomUUID()) : null);
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
  const retireDocument = () => {
    clear();
    visualDocument = undefined;
  };
  const navigate = () => {
    retireDocument();
    override = {};
    owner = undefined;
    declarationRevision = 0;
    themeRevision = 0;
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
  const overlayAvailable = policy.resolvedMode === "native-overlay" && policy.platform !== "darwin";
  const applyOverlay = (): OverlayAppearanceResult => {
    if (!overlayAvailable) return { status: "unsupported", reason: "native-overlay-appearance-unavailable" };
    const dark = preference === "dark" || (preference === "auto" && nativeTheme.shouldUseDarkColors);
    const merged = { ...chromeAppearance(dark), height: policy.appearance.height, ...override };
    try {
      if (
        merged.color !== appearance.color ||
        merged.symbolColor !== appearance.symbolColor ||
        merged.height !== appearance.height
      )
        win.setTitleBarOverlay(merged);
      appearance = merged;
      return { status: "applied", appearance: { ...appearance } };
    } catch {
      log.warn({}, "window overlay appearance update failed");
      return { status: "rejected", reason: "native-update-failed" };
    }
  };
  const applyTheme = (): Pick<Extract<VisualThemeResult, { status: "processed" }>, "background" | "overlay"> => {
    let background: "applied" | "failed" = "applied";
    try {
      const dark = preference === "dark" || (preference === "auto" && nativeTheme.shouldUseDarkColors);
      win.setBackgroundColor(chromeAppearance(dark).color);
    } catch {
      background = "failed";
    }
    const result = applyOverlay();
    return { background, overlay: result.status === "rejected" ? "failed" : result.status };
  };
  const updateAppearance = (event: IpcMainInvokeEvent, input: unknown): OverlayAppearanceResult => {
    if (!trusted(event)) return { status: "rejected", reason: "untrusted-sender" };
    const next = parseOverlayAppearance(input);
    if (!next) return { status: "rejected", reason: "invalid-appearance" };
    if (!overlayAvailable) return { status: "unsupported", reason: "native-overlay-appearance-unavailable" };
    override = { ...override, ...next };
    return applyOverlay();
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
  const syncTheme = (event: IpcMainInvokeEvent, input: unknown): VisualThemeResult => {
    if (!trusted(event)) return { status: "rejected", reason: "untrusted-sender" };
    if (
      typeof input !== "object" ||
      input === null ||
      !("preference" in input) ||
      !isVisualThemePreference(input.preference) ||
      !("document" in input) ||
      typeof input.document !== "string" ||
      !/^[\w-]{1,80}$/.test(input.document) ||
      !("revision" in input) ||
      typeof input.revision !== "number" ||
      !Number.isSafeInteger(input.revision) ||
      input.revision < 1
    )
      return { status: "rejected", reason: "invalid-request" };
    if (input.document !== visualDocument || input.revision <= themeRevision)
      return { status: "rejected", reason: "stale-document" };
    themeRevision = input.revision;
    preference = input.preference;
    return { status: "processed", ...applyTheme(), persistence: themeStore?.save(preference) ? "saved" : "failed" };
  };
  const themeChanged = () => {
    if (!win.isDestroyed() && preference === "auto") applyTheme();
  };
  if (themeListeners.size === 0) nativeTheme.on("updated", notifyThemeListeners);
  themeListeners.add(themeChanged);
  contents.ipc.handle(DESKTOP_CHROME_IPC.visualDocument, getVisualDocument);
  contents.ipc.handle(DESKTOP_CHROME_IPC.declaration, declareAppearance);
  contents.ipc.handle(DESKTOP_CHROME_IPC.visualTheme, syncTheme);
  contents.ipc.handle(DESKTOP_CHROME_IPC.subscribe, subscribe);
  contents.ipc.handle(DESKTOP_CHROME_IPC.appearance, updateAppearance);
  contents.ipc.on(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
  for (const event of STATE_EVENTS) win.on(event, refresh);
  contents.on("did-navigate", navigate);
  contents.on("render-process-gone", retireDocument);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;

    clear();
    themeListeners.delete(themeChanged);
    if (themeListeners.size === 0) nativeTheme.off("updated", notifyThemeListeners);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.visualDocument);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.subscribe);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.appearance);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.declaration);
    contents.ipc.removeHandler(DESKTOP_CHROME_IPC.visualTheme);
    contents.ipc.off(DESKTOP_CHROME_IPC.unsubscribe, unsubscribe);
    for (const event of STATE_EVENTS) win.off(event, refresh);
    contents.off("did-navigate", navigate);
    contents.off("render-process-gone", retireDocument);
    win.off("closed", dispose);
  };
  win.once("closed", dispose);

  return dispose;
}
