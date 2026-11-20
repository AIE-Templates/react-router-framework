import { join } from "node:path";

import type { PortFetch } from "@repo/port-fetch";
import { DESKTOP_PREFS_IPC, shellFromEnv, type DesktopBootstrap, type DesktopRequest } from "@repo/shared";
import { app, type BrowserWindow, dialog, nativeTheme, protocol, session } from "electron";

// These three are replaced per build profile (vite.base.config.ts): import them by exactly these names.
import { readDebugEnv, utilityDebugEnv } from "~/debug-env.ts";
import { selectMainRun } from "~/diagnostics/entry.ts";
import { developmentHost } from "~/main/dev-host.ts";

import { APP_ORIGIN, APP_SCHEME, isAppUrl } from "./main/app-url.ts";
import { createBootProfile } from "./main/boot-profile.ts";
import { resolveChromePolicy } from "./main/chrome-policy.ts";
import { COOKIE_JAR_ORIGIN, createCookieJar, flushForQuit } from "./main/cookie-jar.ts";
import { createLogger } from "./main/log.ts";
import { INTERNAL_ORIGIN } from "./main/mapping.ts";
import { installPermissionPolicy } from "./main/permissions.ts";
import { createPrefsStore, installPrefsIpc } from "./main/prefs.ts";
import { registerAppProtocol } from "./main/protocol.ts";
import type { RecoveryChoice, RecoveryDialog } from "./main/recovery.ts";
import { refuseRemoteDebugging } from "./main/remote-debugging.ts";
import { startServerProcess } from "./main/server-process.ts";
import { configureUserData } from "./main/user-data.ts";
import { createVisualThemeStore } from "./main/visual-theme.ts";
import { createWindowRegistry } from "./main/window-registry.ts";
import { isTrustedSender } from "./main/window.ts";
import { MAIN_WINDOW_READY_MESSAGE } from "./startup-signals.ts";

// First of all, and only in release builds: a launch with a Chromium remote debugging switch ends
// here, before this process starts anything (src/main/remote-debugging.ts).
if (DESKTOP_BUILD_PROFILE === "release") refuseRemoteDebugging();

// The main process must never die of an uncaught exception: Electron shows a blocking dialog for
// those, which stalls the whole app. Log and carry on.
const log = createLogger(process.env.LOG_LEVEL === "debug" ? "debug" : "info");
process.on("uncaughtException", (err) => log.error({ err }, "uncaught exception in the main process"));
process.on("unhandledRejection", (reason) => log.error({ err: reason }, "unhandled rejection in the main process"));
// Logged before anything else can fail, at info, which LOG_LEVEL cannot suppress (the logger's
// threshold is debug or info): launchers that spawn the app depend on this line to know they started
// the bundles they meant to (scripts/launch.ts). Playwright reads the app's stdout itself, so the
// same fact is also left where its driver can evaluate it, except in release builds.
log.info({ buildProfile: DESKTOP_BUILD_PROFILE }, "build profile");
if (DESKTOP_BUILD_PROFILE !== "release") globalThis.desktopBuildProfile = DESKTOP_BUILD_PROFILE;

// The debug variables of dev and test builds; a release build reads none of them (~/debug-env.ts).
const debug = readDebugEnv();
const profile = createBootProfile(debug.bootProfile);
// The dev build's host, whose pages come from `react-router dev`. The build profile decides, and the
// other builds do not even bundle the module (~/main/dev-host.ts).
const dev = DESKTOP_BUILD_PROFILE === "dev" ? developmentHost : undefined;

// A development or test instance keeps its own storage, apart from the installed app's.
const { compileCacheDir } = configureUserData(app, debug.userDataSuffix);

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

async function askRecovery(
  win: BrowserWindow,
  kind: RecoveryDialog,
  shared: boolean,
  signal: AbortSignal,
): Promise<RecoveryChoice> {
  const waiting = kind === "unresponsive";
  if (!win.isVisible()) win.show();
  const choices = waiting ? (["wait", "reload", "close"] as const) : (["reload", "close", "wait"] as const);
  const labels = {
    wait: waiting ? "Wait" : "Cancel",
    reload: shared ? "Reload affected windows" : "Reload",
    close: shared ? "Close affected windows" : "Close",
  };
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: waiting ? "The window is not responding" : "The page failed to load",
    detail: shared
      ? "This choice applies to the affected windows sharing this renderer. Reloading or closing may discard unsaved changes."
      : "Reloading may discard unsaved changes.",
    buttons: choices.map((choice) => labels[choice]),
    signal,
    defaultId: 0,
    cancelId: choices.indexOf("wait"),
  };
  const result = await dialog.showMessageBox(win, options);
  // If the sheet lost its owner, peers that still need a decision can present their own.
  if (signal.aborted || win.isDestroyed()) return "dismissed";
  return choices[result.response] ?? "wait";
}

async function main(): Promise<void> {
  profile.mark("ready");
  const development = dev !== undefined;
  let mainWindowReady = false;
  const appSession = session.fromPartition("persist:app");
  installPermissionPolicy(appSession, log);
  // Preferences the page writes through the preload; every request carries the current ones.
  const visualThemeStore = createVisualThemeStore(app.getPath("userData"), { log });
  const prefsStore = createPrefsStore(app.getPath("userData"), { log });
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
  const registry = createWindowRegistry({
    session: appSession,
    chrome: { bootstrap, currentPolicy: currentChromePolicy, visualThemeStore },
    preloadPath: join(__dirname, "preload.cjs"),
    appVersion: app.getVersion(),
    log,
    profile,
    logRendererConsole: DESKTOP_BUILD_PROFILE !== "release" && (development || debug.smoke),
    keyForUrl: (url) => (/^\/settings\/*$/i.test(url.pathname) ? "settings" : undefined),
    askRecovery,
    // What an external verifier waits for: logged once, at info, in every build profile.
    onReady(_window, fixedKey) {
      if (fixedKey !== "primary" || mainWindowReady) return;
      mainWindowReady = true;
      log.info({}, MAIN_WINDOW_READY_MESSAGE);
    },
  });
  installPrefsIpc(
    prefsStore,
    (event) => isTrustedSender(event, registry.byContentsId(event.sender.id)),
    (event) => {
      for (const window of registry.windows()) {
        if (!window.isDestroyed() && window.webContents !== event.sender && isAppUrl(window.webContents.getURL())) {
          window.webContents.send(DESKTOP_PREFS_IPC.changed);
        }
      }
    },
  );
  const desktop = (contentsId?: number): DesktopRequest => ({
    titlebar: chromePolicy.resolvedMode === "system-decorated" ? "native" : "custom",
    chromeMode: chromePolicy.resolvedMode,
    fullscreen: registry.byContentsId(contentsId)?.isFullScreen() ?? false,
    prefs: prefsStore.current(),
  });

  // Ack coalescing on the main↔utility port, the same on both ends (dev and test builds can turn it
  // off, for the benchmark's comparison).
  const ackCoalesce = debug.ackCoalesce();
  // The benchmark, the smoke and the end-to-end run (and their endpoints) exist only in dev and test
  // builds; in a release build this selects nothing (~/diagnostics/entry.ts).
  const run = selectMainRun(debug, { development, log });

  // Where pages come from: the utility process, or `react-router dev` in the dev build.
  const internalOrigin = dev?.serverUrl ?? INTERNAL_ORIGIN;
  const clientDir = app.isPackaged
    ? join(process.resourcesPath, "client")
    : join(__dirname, "../../../web/build/client");
  let upstream: PortFetch;
  if (dev) {
    upstream = dev.createFetch();
  } else {
    server = startServerProcess({
      utilityPath: join(__dirname, "utility.mjs"),
      clientDir,
      compileCacheDir,
      log,
      onUtilityBoot: (ms) => profile.note("utility-boot-ms", ms),
      onSpawn: () => profile.mark("utility-spawn"),
      onReady: () => profile.mark("utility-ready"),
      ackCoalesce,
      // Dev and test builds: the utility's end follows this end, and learns which run, if any, is
      // this one. A release build passes nothing on.
      env: utilityDebugEnv({ ackCoalesce, ...run.modes }),
      onLifecycle: registry.utilityChanged,
    });
    upstream = server.fetch;
  }
  registerAppProtocol(appSession, {
    upstream,
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
  if (dev) {
    log.info({ devServerUrl: dev.serverUrl }, "development: forwarding app:// to react-router dev");
    dev.onReloadRequest(() => {
      for (const win of registry.windows()) win.webContents.reload();
    });
  }

  const openMainWindow = () => registry.open(APP_ORIGIN + "/", "primary");
  profile.mark("navigation-start");
  const first = openMainWindow();
  const initialLoad = first.loaded ?? Promise.resolve();

  let quitting = false;
  const reopenMainWindow = () => {
    if (quitting) return;
    const { loaded } = openMainWindow();
    void loaded?.catch((err: unknown) => log.error({ err }, "reopened window failed to load"));
  };
  app.on("second-instance", reopenMainWindow);
  app.on("activate", () => {
    // Ordinary activation can leave the user's current child window in front.
    if (!registry.find("primary")) reopenMainWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // A window can veto quit while closing. Keep its recovery and shared server alive until all windows agree.
  app.on("will-quit", function finishQuit(event) {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.allSettled([server?.shutdown(), flushForQuit(appSession.cookies, log)]).finally(() => {
      app.off("will-quit", finishQuit);
      app.quit();
    });
  });

  // did-fail-load is handled by recovery; startup failure must not bypass the native retry path.
  await initialLoad.catch((err: unknown) => {
    log.warn({ err }, "initial document failed; recovery owns retry");
    if (debug.smoke || run.modes.bench) throw err;
  });
  await run.start({
    window: first.window,
    log,
    bootProfile: profile,
    development,
    ackCoalesce,
    internalOrigin,
    server,
    getAppMetrics: () => app.getAppMetrics(),
    exit: async (code) => {
      quitting = true;
      registry.shutdown();
      await server?.shutdown();
      app.exit(code);
    },
  });
}
