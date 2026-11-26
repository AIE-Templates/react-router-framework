import type { BrowserWindow } from "electron";

import { isAppUrl } from "./app-url.ts";
import { safeUrl } from "./log-url.ts";
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
  /**
   * Called once per window, the first time it both holds a successfully loaded document (one
   * answered with a 2xx status) and is visible, whichever comes last; never for a failed load, an
   * HTTP error document or a hidden window. `fixedKey` is the
   * identity the window was opened with (`open`'s), undefined for route-keyed and child windows.
   */
  onReady?(window: BrowserWindow, fixedKey: string | undefined): void;
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
      const shared = [...entries.values()].some((entry) => {
        if (entry.window === win || entry.window.isDestroyed()) return false;
        const peer = entry.window.webContents;
        // A live child can share the opener's renderer before its first navigation commits.
        return (peer.isCrashed() ? entry.pid : peer.getOSProcessId()) === pid;
      });
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

  function adopt(win: BrowserWindow, url: string, fixedKey?: string, fixedAppearance?: "light" | "dark") {
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
    // Set below, once readiness is tracked: the window was just shown by configureWindow.
    let afterShown: (() => void) | undefined;
    const present = configureWindow(win, { ...options, fixedAppearance }, children, () => afterShown?.());
    const entry: Entry = { window: win, recovery, present, key: fixedKey ?? options.keyForUrl(new URL(url)) };
    entries.set(id, entry);
    if (lifecycle) deliver(recovery, lifecycle);

    // Primary identity lasts until close. A route key follows the displayed document, including Back.
    const updateRouteKey = (target: string) => {
      if (fixedKey === undefined) entry.key = isAppUrl(target) ? options.keyForUrl(new URL(target)) : undefined;
    };
    // Chromium also finishes an internal error document after did-fail-load.
    let committed = false;
    // Whether the committed document was answered with a 2xx status. An HTTP error is a document too
    // (the server's own error page; the protocol handler's 500, 503 and 504 answers): it commits,
    // paints, gets the window shown and finishes loading like any other.
    let succeeded = false;
    // Whether the document the window holds loaded successfully: committed with a 2xx status and
    // finished. Neither Chromium's error document nor an HTTP error document is one.
    let loaded = false;
    let ready = false;
    const settleReady = (shown: boolean) => {
      if (ready || !loaded || win.isDestroyed() || !shown) return;
      ready = true;
      options.onReady?.(win, fixedKey);
    };
    // The event itself says the window is shown, whatever a platform reports while it is delivered.
    // Not the only way: on macOS it follows occlusion and does not come while the screen is locked,
    // so a window this app has just shown counts as shown when it says it is visible (measured: on a
    // locked screen with the display asleep, a first launch whose document finished before its first
    // paint waited for the event in vain while `isVisible()` was true).
    win.on("show", () => settleReady(true));
    afterShown = () => settleReady(win.isVisible());
    contents.on("did-navigate", (_event, target, httpResponseCode) => {
      committed = true;
      succeeded = httpResponseCode >= 200 && httpResponseCode < 300;
      // The document before it is gone, and this one has not finished.
      loaded = false;
      entry.pid = contents.getOSProcessId();
      updateRouteKey(target);
    });
    contents.on("did-finish-load", () => {
      if (!committed) return;
      recovery.documentLoaded(contents.getURL());
      loaded = succeeded;
      settleReady(win.isVisible());
    });
    contents.on("did-navigate-in-page", (_event, target, isMainFrame) => {
      if (isMainFrame) updateRouteKey(target);
      recovery.sameDocumentNavigated(target, isMainFrame);
    });
    contents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) committed = succeeded = loaded = false;
      recovery.didFailLoad({ errorCode, isMainFrame });
    });
    // A close in progress (a user's, or every window's when the app quits) waits for the renderer to
    // run the page's beforeunload and unload. A renderer that is gone by then can neither finish the
    // close nor veto it: Electron would keep the window open for good, recovery would reload it and,
    // once the reloaded page does not answer the pending close, ask about an unresponsive window, and
    // a quit would never get past it (a signal to the whole process group kills the renderer while the
    // main process starts quitting). Such a window is destroyed instead. A page that vetoes the close
    // (`will-prevent-unload`) keeps it, and its recovery.
    let closing = false;
    win.on("close", (event: Electron.Event) => {
      // Another `close` listener may still prevent it: decide once all of them ran.
      queueMicrotask(() => (closing = !event.defaultPrevented));
    });
    contents.on("will-prevent-unload", () => (closing = false));
    contents.on("render-process-gone", (_event, details) => {
      if (closing && !win.isDestroyed()) {
        options.log.warn(
          { reason: details.reason },
          "renderer gone while its window was closing; destroying the window",
        );
        win.destroy();
        return;
      }
      recovery.rendererGone(details.reason);
    });
    // Logged, since what follows can be a native sheet waiting for a click: a run that stalls on one
    // shows why in its log.
    win.on("unresponsive", () => {
      options.log.warn({ path: safeUrl(contents.getURL()) }, "window unresponsive");
      recovery.unresponsive();
    });
    win.on("responsive", () => {
      options.log.info({}, "window responsive again");
      recovery.responsive();
    });
    win.once("closed", () => {
      recovery.shutdown();
      entries.delete(id);
    });
  }

  const children = {
    reuse: (url: string) => !!focusExisting(options.keyForUrl(new URL(url))),
    adopt(win: BrowserWindow, url: string, fixedAppearance?: "light" | "dark") {
      // Two openers can request the same key before either native child is delivered.
      // Discard the still-hidden duplicate before configuring its preload IPC or showing it.
      if (children.reuse(url)) win.destroy();
      else adopt(win, url, undefined, fixedAppearance);
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
