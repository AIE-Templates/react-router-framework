import type { BrowserWindow } from "electron";

import { isAppUrl } from "./app-url.ts";
import { createWindowRecovery, type RecoveryChoice, type RecoveryDialog } from "./recovery.ts";
import type { UtilityLifecycle } from "./server-process.ts";
import { configureWindow, createAppWindow, type WindowOptions } from "./window.ts";

interface RegistryOptions extends WindowOptions {
  /** Application routes that should reuse a dedicated window when opened again. */
  keyForUrl(url: URL): string | undefined;
  askRecovery(
    window: BrowserWindow,
    kind: RecoveryDialog,
    shared: boolean,
    signal: AbortSignal,
  ): Promise<RecoveryChoice>;
}

type Recovery = ReturnType<typeof createWindowRecovery>;
interface Entry {
  window: BrowserWindow;
  key?: string;
  recovery: Recovery;
  present(): void;
  /** The exited renderer is no longer accessible through getOSProcessId(). */
  pid?: number;
}

function deliver(recovery: Recovery, { state, generation }: UtilityLifecycle) {
  if (state === "starting") recovery.utilityStarting(generation);
  else if (state === "failed") recovery.utilityFailed(generation);
  else recovery.utilityReady(generation);
}

/** Owns every live application window from creation, before the initial document can send IPC. */
export function createWindowRegistry(options: RegistryOptions) {
  const entries = new Map<number, Entry>();
  const dialogs = new Map<string, { owner: AbortSignal; choice: Promise<RecoveryChoice> }>();
  let lifecycle: UtilityLifecycle | undefined;

  function findEntry(key: string | undefined) {
    if (key === undefined) return undefined;
    for (const entry of entries.values()) {
      if (entry.key === key && !entry.window.isDestroyed()) return entry;
    }
    return undefined;
  }

  function focusExisting(key: string | undefined) {
    const entry = findEntry(key);
    entry?.present();
    return entry?.window;
  }

  function choose(win: BrowserWindow, kind: RecoveryDialog, signal: AbortSignal) {
    const contents = win.webContents;
    const pid =
      kind === "unresponsive" ? contents.getOSProcessId() : contents.isCrashed() && entries.get(contents.id)?.pid;
    if (pid) {
      const key = kind + ":" + pid;
      const pending = dialogs.get(key);
      if (pending && !pending.owner.aborted) return pending.choice;
      const shared = [...entries.values()].some(
        (entry) => entry.window !== win && !entry.window.isDestroyed() && entry.pid === pid,
      );
      if (shared) {
        const choice = options.askRecovery(win, kind, true, signal).finally(() => {
          if (dialogs.get(key)?.owner === signal) dialogs.delete(key);
        });
        dialogs.set(key, { owner: signal, choice });
        return choice;
      }
    }
    return options.askRecovery(win, kind, false, signal);
  }

  function adopt(win: BrowserWindow, url: string, fixedKey?: string) {
    const contents = win.webContents;
    const id = contents.id;
    const recovery = createWindowRecovery(url, {
      isDestroyed: () => win.isDestroyed(),
      reload: (target) => win.loadURL(target),
      cancelReload: () => contents.stop(),
      close: () => win.close(),
      showDialog: (kind, signal) => choose(win, kind, signal),
      onError: (err) => options.log.warn({ err }, "window recovery operation failed"),
    });
    const present = configureWindow(win, options, children);
    const entry: Entry = { window: win, recovery, present, key: fixedKey ?? options.keyForUrl(new URL(url)) };
    entries.set(id, entry);
    if (lifecycle) deliver(recovery, lifecycle);

    // Primary identity lasts until close. A route key follows the displayed document, including Back.
    const updateRouteKey = (target: string) => {
      if (fixedKey === undefined) entry.key = isAppUrl(target) ? options.keyForUrl(new URL(target)) : undefined;
    };
    // Chromium also finishes an internal error document after did-fail-load.
    let committed = false;
    contents.on("did-navigate", (_event, target) => {
      committed = true;
      entry.pid = contents.getOSProcessId();
      updateRouteKey(target);
    });
    contents.on("did-finish-load", () => {
      if (committed) recovery.documentLoaded(contents.getURL());
    });
    contents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
      if (isMainFrame) updateRouteKey(target);
      recovery.sameDocumentNavigated(target, isMainFrame);
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) committed = false;
      recovery.didFailLoad({ errorCode, isMainFrame });
    });
    contents.on("render-process-gone", (_event, details) => recovery.rendererGone(details.reason));
    win.on("unresponsive", recovery.unresponsive);
    win.on("responsive", recovery.responsive);
    win.once("closed", () => {
      recovery.shutdown();
      entries.delete(id);
    });
  }

  const children = {
    reuse: (url: string) => !!focusExisting(options.keyForUrl(new URL(url))),
    adopt(win: BrowserWindow, url: string) {
      // Two openers can request the same key before either native child is delivered.
      // Discard the still-hidden duplicate before configuring its preload IPC or showing it.
      if (children.reuse(url)) win.destroy();
      else adopt(win, url);
    },
  };

  return {
    find: (key: string) => findEntry(key)?.window,
    byContentsId(id: number | undefined) {
      const win = id === undefined ? undefined : entries.get(id)?.window;
      return win?.isDestroyed() ? undefined : win;
    },
    *windows() {
      for (const { window } of entries.values()) yield window;
    },
    open(url: string, fixedKey?: string) {
      if (!isAppUrl(url)) throw new Error("Can only open application URLs");
      const existing = focusExisting(fixedKey ?? options.keyForUrl(new URL(url)));
      if (existing) return { window: existing, loaded: undefined };
      const window = createAppWindow(options);
      adopt(window, url, fixedKey);
      return { window, loaded: window.loadURL(url) };
    },
    utilityChanged(this: void, event: UtilityLifecycle) {
      lifecycle = event;
      for (const { recovery } of entries.values()) deliver(recovery, event);
    },
    shutdown() {
      for (const { recovery } of entries.values()) recovery.shutdown();
    },
  };
}
