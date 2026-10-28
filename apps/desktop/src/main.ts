import { readFileSync } from "node:fs";
import { join } from "node:path";

import { shellFromEnv, type DesktopBootstrap, type DesktopRequest } from "@repo/shared";
import { app, type BrowserWindow, dialog, nativeTheme, protocol, session } from "electron";

import { benchConfigFromEnv, runBench } from "./main/bench.ts";
import { createBootProfile } from "./main/boot-profile.ts";
import { resolveChromePolicy } from "./main/chrome-policy.ts";
import { COOKIE_JAR_ORIGIN, createCookieJar, flushForQuit } from "./main/cookie-jar.ts";
import { createDevProxyFetch } from "./main/dev-proxy.ts";
import { createLogger } from "./main/log.ts";
import { INTERNAL_ORIGIN } from "./main/mapping.ts";
import { createPrefsStore, installPrefsIpc } from "./main/prefs.ts";
import { APP_SCHEME, registerAppProtocol } from "./main/protocol.ts";
import { createWindowRecovery } from "./main/recovery.ts";
import { resolveRunModes } from "./main/run-modes.ts";
import { startServerProcess } from "./main/server-process.ts";
import { runSmoke } from "./main/smoke.ts";
import { createMainWindow, createWindowKeeper, isAppUrl, isTrustedSender } from "./main/window.ts";
import { portAckCoalesce } from "./port-options.ts";

// Node's compile cache for the utility process (NODE_COMPILE_CACHE covers its 1 MB bundle: about
// 15 ms off its boot once warm). Not enabled here: the main bundle is small and loads nothing else,
// and measuring showed no change. Under userData, which is known before `ready`.
const compileCacheDir = join(app.getPath("userData"), "compile-cache");

// The main process must never die of an uncaught exception: Electron shows a blocking dialog for
// those, which stalls the whole app. Log and carry on.
const log = createLogger(process.env.LOG_LEVEL === "debug" ? "debug" : "info");
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception in the main process"));
process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled rejection in the main process"));

const profile = createBootProfile();
const devServerUrl = DESKTOP_DEV_SERVER_URL;

// A development instance keeps its own storage, apart from the installed app's.
if (process.env.DESKTOP_USER_DATA_SUFFIX) {
  app.setPath("userData", `${app.getPath("userData")}-${process.env.DESKTOP_USER_DATA_SUFFIX}`);
}

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

/** The main window, tracked across close and reopen; set once `main()` can create windows. */
let windows: { current(): BrowserWindow | undefined; open(): { window: BrowserWindow; created: boolean } } | undefined;
const mainWindow = () => windows?.current();
/** The utility process, once started, so a failed startup can still shut it down. */
let server: ReturnType<typeof startServerProcess> | undefined;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const win = mainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
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

async function main(): Promise<void> {
  profile.mark("ready");
  const appSession = session.fromPartition("persist:app");
  // Preferences the page writes through the preload; every request carries the current ones.
  const prefsStore = createPrefsStore(app.getPath("userData"), { log });
  installPrefsIpc(prefsStore, (event) => isTrustedSender(event, mainWindow()));
  const shell = shellFromEnv({
    WEB_SHELL: "desktop",
    WEB_SHELL_PLATFORM: process.platform,
    WEB_SHELL_OS_VERSION: process.getSystemVersion(),
    WEB_SHELL_DESKTOP_ENV: process.env.XDG_CURRENT_DESKTOP,
    WEB_SHELL_SESSION_TYPE: process.env.XDG_SESSION_TYPE,
  });
  if (shell.kind !== "desktop") throw new Error("Unsupported desktop platform");
  const requested = process.env.DESKTOP_CHROME_MODE;
  const chromePolicy = resolveChromePolicy({
    platform: shell.platform,
    requestedMode: requested === "system-decorated" || requested === "custom-controls" ? requested : "native-overlay",
    prefs: prefsStore.current(),
    darkColors: nativeTheme.shouldUseDarkColors,
  });
  const bootstrap: DesktopBootstrap = { protocolVersion: 1, shell, mode: chromePolicy.resolvedMode };
  if (chromePolicy.fallbackReason) log.info({ reason: chromePolicy.fallbackReason }, "using system window decoration");
  const recovery = createWindowRecovery<BrowserWindow>({
    current: mainWindow,
    isAppUrl,
    reload: (win, url) => win.loadURL(url),
    cancelReload: (win) => win.webContents.stop(),
    close: (win) => win.close(),
    showDialog: async (win, kind) => {
      const waiting = kind === "unresponsive";
      // Initial document failures can happen before the normal first-paint show path.
      if (!win.isVisible()) win.show();
      const result = await dialog.showMessageBox(win, {
        type: "warning",
        message: waiting ? "The window is not responding" : "The page failed to load",
        detail: "Reloading may discard unsaved changes.",
        buttons: waiting ? ["Wait", "Reload", "Close"] : ["Reload", "Close"],
        defaultId: 0,
        cancelId: waiting ? 0 : 1,
      });
      return waiting
        ? ((["wait", "reload", "close"] as const)[result.response] ?? "wait")
        : result.response === 0
          ? "reload"
          : "close";
    },
    onError: (err) => log.warn({ err }, "window recovery operation failed"),
  });
  const desktop = (): DesktopRequest => ({
    titlebar: chromePolicy.resolvedMode === "system-decorated" ? "native" : "custom",
    chromeMode: chromePolicy.resolvedMode,
    fullscreen: mainWindow()?.isFullScreen() ?? false,
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
        onLifecycle: ({ generation, state, restarted }) => {
          if (state === "starting") recovery.utilityStarting(generation);
          else if (state === "ready") recovery.utilityReady(generation, { restarted });
          else recovery.utilityFailed(generation);
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
      if (chunk.toString().includes("reload")) mainWindow()?.webContents.reload();
    });
  }

  const windowOptions = {
    session: appSession,
    chrome: { bootstrap, policy: chromePolicy },
    preloadPath: join(__dirname, "preload.cjs"),
    appVersion: app.getVersion(),
    log,
    profile,
    logRendererConsole: devServerUrl !== undefined || process.env.DESKTOP_SMOKE === "1",
  };
  // Every window, the first or one made on `activate`, goes through the keeper and gets the same
  // `closed` bookkeeping; a second close followed by a Dock click reopens like the first did.
  windows = createWindowKeeper(() => createMainWindow(windowOptions));
  const openMainWindow = () => {
    const opened = windows!.open();
    if (opened.created) {
      const win = opened.window;
      recovery.track(win, `${APP_SCHEME}://app/`);
      win.webContents.on("did-finish-load", () => recovery.documentLoaded(win, win.webContents.getURL()));
      win.webContents.on("did-navigate-in-page", (_event, url, isMainFrame) =>
        recovery.sameDocumentNavigated(win, url, isMainFrame),
      );
      win.webContents.on("did-fail-load", (_event, errorCode, _description, _url, isMainFrame) =>
        recovery.didFailLoad(win, { errorCode, isMainFrame }),
      );
      win.webContents.on("render-process-gone", (_event, details) => recovery.rendererGone(win, details.reason));
      win.on("unresponsive", () => recovery.unresponsive(win));
      win.on("responsive", () => recovery.responsive(win));
      win.once("closed", () => recovery.closed(win));
    }
    return {
      window: opened.window,
      loaded: opened.created ? opened.window.loadURL(`${APP_SCHEME}://app/`) : undefined,
    };
  };
  profile.mark("navigation-start");
  const first = openMainWindow();
  const loaded = first.loaded ?? Promise.resolve();

  app.on("activate", () => {
    void openMainWindow().loaded?.catch((err: unknown) => log.error({ err }, "reopened window failed to load"));
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let quitting = false;
  app.on("before-quit", (event) => {
    recovery.shutdown();
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    // Cookies the jar wrote just before quitting reach the disk (HOST-09), alongside the utility's
    // shutdown (itself bounded by its grace period); the flush is bounded too, so quitting cannot hang.
    void Promise.allSettled([server?.shutdown(), flushForQuit(appSession.cookies, log)]).finally(() => app.quit());
  });

  // did-fail-load is handled by recovery; startup failure must not bypass the native retry path.
  await loaded.catch((err: unknown) => {
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
        recovery.shutdown();
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
      exit: async (code) => {
        quitting = true;
        recovery.shutdown();
        await server?.shutdown();
        app.exit(code);
      },
    });
  }
}
