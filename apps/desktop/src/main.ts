import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DESKTOP_PREFS_IPC, shellFromEnv, type DesktopBootstrap, type DesktopRequest } from "@repo/shared";
import { app, type BrowserWindow, dialog, nativeTheme, protocol, session } from "electron";

import { benchConfigFromEnv, runBench } from "./diagnostics/bench/bench.ts";
import { runSmoke } from "./diagnostics/smoke/smoke.ts";
import { APP_ORIGIN, APP_SCHEME, isAppUrl } from "./main/app-url.ts";
import { createBootProfile } from "./main/boot-profile.ts";
import { resolveChromePolicy } from "./main/chrome-policy.ts";
import { COOKIE_JAR_ORIGIN, createCookieJar, flushForQuit } from "./main/cookie-jar.ts";
import { createDevProxyFetch } from "./main/dev-proxy.ts";
import { createLogger } from "./main/log.ts";
import { INTERNAL_ORIGIN } from "./main/mapping.ts";
import { installPermissionPolicy } from "./main/permissions.ts";
import { createPrefsStore, installPrefsIpc } from "./main/prefs.ts";
import { registerAppProtocol } from "./main/protocol.ts";
import { createWindowRecovery, type RecoveryChoice, type RecoveryDialog } from "./main/recovery.ts";
import { resolveRunModes } from "./main/run-modes.ts";
import { startServerProcess, type UtilityLifecycle } from "./main/server-process.ts";
import { configureUserData } from "./main/user-data.ts";
import { createVisualThemeStore } from "./main/visual-theme.ts";
import { createMainWindow, createWindowKeeper, isTrustedSender } from "./main/window.ts";
import { portAckCoalesce } from "./port-options.ts";

// The main process must never die of an uncaught exception: Electron shows a blocking dialog for
// those, which stalls the whole app. Log and carry on.
const log = createLogger(process.env.LOG_LEVEL === "debug" ? "debug" : "info");
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception in the main process"));
process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled rejection in the main process"));

const profile = createBootProfile();
const devServerUrl = DESKTOP_DEV_SERVER_URL;

// A development instance keeps its own storage, apart from the installed app's.
const { compileCacheDir } = configureUserData(app, process.env.DESKTOP_USER_DATA_SUFFIX);

// Before `ready`: the scheme behaves like https (standard origin, fetch and streams, CORS, code cache).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      codeCache: true,
    },
  },
]);

/** The utility process, once started, so a failed startup can still shut it down. */
let server: ReturnType<typeof startServerProcess> | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Not awaited at the top level: Electron defers `ready` until this module has evaluated. One
  // `catch` for both `whenReady` and `main` itself: a failure anywhere in startup exits.
  app
    .whenReady()
    .then(main)
    .catch(async (err: unknown) => {
      log.error({ err }, "startup failed");
      await server?.shutdown().catch(() => {});
      app.exit(1);
    });
}

/**
 * The electron-builder profile a packaged app was built with (`extraMetadata.desktopProfile` in
 * electron-builder.yml: "test", or "release" in electron-builder.release.yml); undefined unpackaged.
 */
function packagedProfile(): string | undefined {
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(app.getAppPath(), "package.json"), "utf8"));
    return typeof metadata === "object" && metadata !== null && "desktopProfile" in metadata
      ? String(metadata.desktopProfile)
      : undefined;
  } catch {
    return undefined;
  }
}

async function askRecovery(win: BrowserWindow, kind: RecoveryDialog, shared: boolean): Promise<RecoveryChoice> {
  const waiting = kind === "unresponsive";
  if (!win.isVisible()) win.show();
  const reload = shared ? "Reload affected windows" : "Reload";
  const close = shared ? "Close affected windows" : "Close";
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: waiting ? "The window is not responding" : "The page failed to load",
    detail: shared
      ? "This choice applies to the affected windows sharing this renderer. Reloading or closing may discard unsaved changes."
      : "Reloading may discard unsaved changes.",
    buttons: waiting ? ["Wait", reload, close] : [reload, close],
    defaultId: 0,
    cancelId: waiting ? 0 : 1,
  };
  const result = await dialog.showMessageBox(win, options);
  // Closing the sheet's owner is not a decision to close the other windows.
  if (shared && win.isDestroyed()) return "dismissed";
  return waiting
    ? ((["wait", "reload", "close"] as const)[result.response] ?? "wait")
    : result.response === 0
      ? "reload"
      : "close";
}

async function main(): Promise<void> {
  profile.mark("ready");
  const ownedWindows = new Map<number, BrowserWindow>();
  const appSession = session.fromPartition("persist:app");
  installPermissionPolicy(appSession, log);
  // Preferences the page writes through the preload; every request carries the current ones.
  const visualThemeStore = createVisualThemeStore(app.getPath("userData"), { log });
  const prefsStore = createPrefsStore(app.getPath("userData"), { log });
  installPrefsIpc(
    prefsStore,
    (event) => isTrustedSender(event, ownedWindows.get(event.sender.id)),
    (event) => {
      for (const window of ownedWindows.values()) {
        if (!window.isDestroyed() && window.webContents !== event.sender && isAppUrl(window.webContents.getURL())) {
          window.webContents.send(DESKTOP_PREFS_IPC.changed);
        }
      }
    },
  );
  const shell = shellFromEnv({
    WEB_SHELL: "desktop",
    WEB_SHELL_PLATFORM: process.platform,
    WEB_SHELL_OS_VERSION: process.getSystemVersion(),
    WEB_SHELL_DESKTOP_ENV: process.env.XDG_CURRENT_DESKTOP,
    WEB_SHELL_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
  });
  if (shell.kind !== "desktop") throw new Error("Unsupported desktop platform");
  const requested = process.env.DESKTOP_CHROME_MODE;
  const currentChromePolicy = () =>
    resolveChromePolicy({
      platform: shell.platform,
      requestedMode: requested === "system-decorated" || requested === "custom-controls" ? requested : "native-overlay",
      themePreference: visualThemeStore.current(),
      darkColors: nativeTheme.shouldUseDarkColors,
    });
  const chromePolicy = currentChromePolicy();
  const bootstrap: DesktopBootstrap = { protocolVersion: 1, shell, mode: chromePolicy.resolvedMode };
  if (chromePolicy.fallbackReason) log.info({ reason: chromePolicy.fallbackReason }, "using system window decoration");
  // After a crash getOSProcessId() no longer identifies the exited renderer.
  const rendererPids = new WeakMap<BrowserWindow, number>();
  const dialogChoices = new Map<string, Promise<RecoveryChoice>>();
  const makeRecovery = (owner: BrowserWindow) =>
    createWindowRecovery<BrowserWindow>({
      current: () => owner,
      isAppUrl,
      reload: (win, url) => win.loadURL(url),
      cancelReload: (win) => win.webContents.stop(),
      close: (win) => win.close(),
      showDialog: (win, kind) => {
        const pid =
          kind === "unresponsive"
            ? win.webContents.getOSProcessId()
            : win.webContents.isCrashed() && rendererPids.get(win);
        if (!pid) return askRecovery(win, kind, false);
        const key = kind + ":" + pid;
        const pending = dialogChoices.get(key);
        if (pending) return pending;
        const shared = [...ownedWindows.values()].some((other) => other !== win && rendererPids.get(other) === pid);
        if (!shared) return askRecovery(win, kind, false);
        const choice = askRecovery(win, kind, true).finally(() => {
          dialogChoices.delete(key);
        });
        dialogChoices.set(key, choice);
        return choice;
      },
      onError: (err) => log.warn({ err }, "window recovery operation failed"),
    });
  const recoveries = new Set<ReturnType<typeof makeRecovery>>();
  let lifecycle: UtilityLifecycle | undefined;
  const desktop = (contentsId?: number): DesktopRequest => ({
    titlebar: chromePolicy.resolvedMode === "system-decorated" ? "native" : "custom",
    chromeMode: chromePolicy.resolvedMode,
    fullscreen: (contentsId === undefined ? undefined : ownedWindows.get(contentsId))?.isFullScreen() ?? false,
    prefs: prefsStore.current(),
  });

  // Ack coalescing on the main↔utility port, the same on both ends (DESKTOP_PORT_ACK_COALESCE=0
  // turns it off, for the benchmark's comparison).
  const ackCoalesce = portAckCoalesce(process.env.DESKTOP_PORT_ACK_COALESCE);
  // The bench and the e2e run (and their endpoints) only unpackaged or on the packaged test profile,
  // never on the release profile; the smoke on any build (src/main/run-modes.ts).
  const { bench, smoke, e2e, ignored } = resolveRunModes({
    env: process.env,
    development: devServerUrl !== undefined,
    packaged: app.isPackaged,
    profile: packagedProfile,
  });
  for (const { variable, reason } of ignored) log.warn({ reason }, `${variable} ignored`);
  const benchConfig = bench ? benchConfigFromEnv(process.env) : undefined;

  // Where pages come from: the utility process in production, `react-router dev` in development.
  const internalOrigin = devServerUrl ?? INTERNAL_ORIGIN;
  const clientDir = app.isPackaged
    ? join(process.resourcesPath, "client")
    : join(__dirname, "../../../web/build/client");
  server = devServerUrl
    ? undefined
    : startServerProcess({
        utilityPath: join(__dirname, "utility.mjs"),
        clientDir,
        compileCacheDir,
        log,
        onUtilityBoot: (ms) => profile.note("utility-boot-ms", ms),
        onSpawn: () => profile.mark("utility-spawn"),
        onReady: () => profile.mark("utility-ready"),
        ackCoalesce,
        // The utility's end follows this end; DESKTOP_BENCH, DESKTOP_SMOKE and DESKTOP_E2E reach it
        // only when the bench, the smoke or the end-to-end run is this one.
        env: {
          DESKTOP_PORT_ACK_COALESCE: ackCoalesce ? "1" : "0",
          DESKTOP_BENCH: bench ? "1" : "",
          DESKTOP_SMOKE: smoke ? "1" : "",
          DESKTOP_E2E: e2e ? "1" : "",
        },
        onLifecycle: (event) => {
          lifecycle = event;
          const { generation, state } = event;
          for (const recovery of recoveries) {
            if (state === "starting") recovery.utilityStarting(generation);
            else if (state === "ready") recovery.utilityReady(generation);
            else recovery.utilityFailed(generation);
          }
        },
      });
  registerAppProtocol(appSession, {
    upstream: server ? server.fetch : createDevProxyFetch(),
    internalOrigin,
    desktop,
    // A `Domain` attribute may name the jar's host or the host the server sees (the dev server's).
    cookies: createCookieJar({
      store: appSession.cookies,
      hosts: [new URL(COOKIE_JAR_ORIGIN).hostname, new URL(internalOrigin).hostname],
      log,
    }),
    log,
    profile,
  });
  if (devServerUrl) {
    log.info({ devServerUrl }, "development: forwarding app:// to react-router dev");
    // scripts/dev.ts writes "reload" on stdin when the preload script was rebuilt.
    process.stdin.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("reload")) for (const win of ownedWindows.values()) win.webContents.reload();
    });
  }

  const windowOptions = {
    onChildWindow: trackWindow,
    session: appSession,
    chrome: { bootstrap, currentPolicy: currentChromePolicy, visualThemeStore },
    preloadPath: join(__dirname, "preload.cjs"),
    appVersion: app.getVersion(),
    log,
    profile,
    logRendererConsole: devServerUrl !== undefined || process.env.DESKTOP_SMOKE === "1",
  };
  const mainWindows = createWindowKeeper(() => createMainWindow(windowOptions));
  function trackWindow(win: BrowserWindow, initialUrl: string) {
    const id = win.webContents.id;
    ownedWindows.set(id, win);
    const recovery = makeRecovery(win);
    recoveries.add(recovery);
    recovery.track(win, initialUrl);
    if (lifecycle?.state === "starting") recovery.utilityStarting(lifecycle.generation);
    if (lifecycle?.state === "failed") recovery.utilityFailed(lifecycle.generation);
    // Chromium also finishes an internal error document after did-fail-load,
    // and getURL() still returns the failed app URL. Only a committed navigation can recover.
    let committed = false;
    win.webContents.on("did-navigate", () => {
      committed = true;
      rendererPids.set(win, win.webContents.getOSProcessId());
    });
    win.webContents.on("did-finish-load", () => {
      if (committed) recovery.documentLoaded(win, win.webContents.getURL());
    });
    win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) =>
      recovery.sameDocumentNavigated(win, url, isMainFrame),
    );
    win.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) committed = false;
      recovery.didFailLoad(win, { errorCode, isMainFrame });
    });
    win.webContents.on("render-process-gone", (_event, details) => recovery.rendererGone(win, details.reason));
    win.on("unresponsive", () => recovery.unresponsive(win));
    win.on("responsive", () => recovery.responsive(win));
    win.once("closed", () => {
      recovery.closed(win);
      recovery.shutdown();
      recoveries.delete(recovery);
      ownedWindows.delete(id);
    });
  }
  const openMainWindow = () => {
    const { window, created } = mainWindows.open();
    if (!created) return { window, loaded: undefined };
    const url = APP_ORIGIN + "/";
    trackWindow(window, url);
    return { window, loaded: window.loadURL(url) };
  };
  profile.mark("navigation-start");
  const first = openMainWindow();
  const initialLoad = first.loaded ?? Promise.resolve();

  const reopenMainWindow = () => {
    const { window, loaded } = openMainWindow();
    if (loaded) {
      void loaded.catch((err: unknown) => log.error({ err }, "reopened window failed to load"));
    } else {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  };
  app.on("second-instance", reopenMainWindow);
  app.on("activate", () => {
    // Ordinary activation can leave the user's current child window in front.
    if (!mainWindows.current()) reopenMainWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    for (const recovery of recoveries) recovery.shutdown();
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // Cookies the jar wrote just before quitting reach the disk (HOST-09), alongside the utility's
    // shutdown (itself bounded by its grace period); the flush is bounded too, so quitting cannot hang.
    void Promise.allSettled([server?.shutdown(), flushForQuit(appSession.cookies, log)]).finally(() => app.quit());
  });

  // did-fail-load is handled by recovery; startup failure must not bypass the native retry path.
  await initialLoad.catch((err: unknown) => {
    log.warn({ err }, "initial document failed; recovery owns retry");
    if (process.env.DESKTOP_SMOKE === "1" || benchConfig) throw err;
  });
  if (benchConfig && server) {
    const utility = server;
    await runBench({
      win: first.window,
      config: benchConfig,
      ackCoalesce,
      log,
      getAppMetrics: () => app.getAppMetrics(),
      utilityFetch: utility.fetch,
      internalOrigin,
      clientStats: () => utility.stats(),
      exit: async (code) => {
        quitting = true;
        for (const recovery of recoveries) recovery.shutdown();
        await utility.shutdown();
        app.exit(code);
      },
    });
  } else if (smoke) {
    await runSmoke(first.window, {
      profile,
      log,
      development: devServerUrl !== undefined,
      smokeRoutes: server !== undefined,
      layout: process.env.DESKTOP_SMOKE_LAYOUT === "1",
      exit: async (code) => {
        quitting = true;
        for (const recovery of recoveries) recovery.shutdown();
        await server?.shutdown();
        app.exit(code);
      },
    });
  }
}
