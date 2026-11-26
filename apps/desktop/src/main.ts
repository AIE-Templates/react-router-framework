import { writeSync } from "node:fs";
import { join } from "node:path";

import {
  createCookieJar,
  flushForQuit,
  installCookieIpc,
  installCookieWorkerIpc,
  type CookieIpcOptions,
} from "@repo/electron-cookies/main";
import type { PortFetch } from "@repo/port-fetch";
import { DESKTOP_PREFS_IPC, shellFromEnv, type DesktopBootstrap, type DesktopRequest } from "@repo/shared";
import { app, type BrowserWindow, dialog, ipcMain, nativeTheme, protocol, safeStorage, session } from "electron";

import type { DebugEnv } from "~/debug-env.contract.ts";
// These three are replaced per build profile (vite.base.config.ts): import them by exactly these names.
import { readDebugEnv, utilityDebugEnv } from "~/debug-env.ts";
import { selectMainRun } from "~/diagnostics/entry.ts";
import { developmentHost } from "~/main/dev-host.ts";

import { demoChildAppearance } from "./demo/child-appearance.ts";
import { APP_HOST, APP_ORIGIN, APP_SCHEME, COOKIE_JAR_ORIGIN, isAppUrl } from "./main/app-url.ts";
import { type BootProfile, createBootProfile } from "./main/boot-profile.ts";
import { resolveChromePolicy } from "./main/chrome-policy.ts";
import {
  checkCookieKeyProbe,
  COOKIE_KEY_PROBE_TEXT,
  cookieKeyProbeLine,
  type CookieKeyOutcome,
  cookieKeyWriterCrashHandler,
  storeCookieKeyFirst,
} from "./main/cookie-key.ts";
import { cookieWakeStorage } from "./main/cookie-wake-storage.ts";
import { openFirstWindow } from "./main/first-window.ts";
import { createLogger, type Logger } from "./main/log.ts";
import { INTERNAL_ORIGIN } from "./main/mapping.ts";
import { installPermissionPolicy } from "./main/permissions.ts";
import { createPrefsStore, installPrefsIpc } from "./main/prefs.ts";
import { registerAppProtocol } from "./main/protocol.ts";
import type { RecoveryChoice, RecoveryDialog } from "./main/recovery.ts";
import { refuseRemoteDebugging } from "./main/remote-debugging.ts";
import { startServerProcess } from "./main/server-process.ts";
import { configureUserData } from "./main/user-data.ts";
import { installVisualIpc } from "./main/visual-ipc.ts";
import { createVisualMirror } from "./main/visual-mirror.ts";
import { createWindowRegistry } from "./main/window-registry.ts";
import { isTrustedSender } from "./main/window.ts";
import {
  COOKIE_KEY_CHECKED_MESSAGE,
  COOKIE_KEY_MISMATCH_MESSAGE,
  COOKIE_KEY_NO_PROBE_MESSAGE,
  COOKIE_KEY_NOT_STORED_MESSAGE,
  COOKIE_KEY_SKIPPED_MESSAGE,
  COOKIE_KEY_STORED_MESSAGE,
  COOKIE_KEY_UNREADABLE_MESSAGE,
  COOKIE_KEY_UNKNOWN_MESSAGE,
  COOKIE_KEY_WRITER_SWITCH,
  MAIN_WINDOW_READY_MESSAGE,
} from "./startup-signals.ts";

// The order of a launch, up to `ready`:
// 1. Release builds: a launch with a Chromium remote debugging switch ends here, before this process
//    starts anything (src/main/remote-debugging.ts). Cookie key writers are launches like any other.
// 2. Windows, test and release builds: a cookie key writer (COOKIE_KEY_WRITER_SWITCH, started by step
//    5 of another launch) lets Chromium make the cookie key, prints its probe and quits at `ready`
//    (`runCookieKeyWriter`): no log, no scheme, no lock, no window, no utility, and nothing of the app's
//    own in userData. Chromium itself writes there what any start of it writes: Local State (which is
//    the point) and directories of its own, such as Crashpad and caches.
// 3. Logging, the build profile line, the debug variables, the userData directory.
// 4. The single-instance lock; a second instance quits here.
// 5. Windows, test and release builds: a profile whose Local State has no cookie key yet gets one from
//    a key writer this launch runs and waits for (src/main/cookie-key.ts), holding the lock, so two
//    launches started together never both run one.
// 6. The scheme registration, then `main` once ready.
if (DESKTOP_BUILD_PROFILE === "release") refuseRemoteDebugging();

/** What the launch prepared before `ready`, for `main`. */
interface Startup {
  log: Logger;
  debug: DebugEnv;
  profile: BootProfile;
  compileCacheDir: string;
  cookieKey: CookieKeyOutcome;
}

/** The utility process, once started, so a failed startup can still shut it down. */
let server: ReturnType<typeof startServerProcess> | undefined;
// The dev build's host, whose pages come from `react-router dev`; undefined in test and release
// builds, which bundle its empty implementation instead (~/main/dev-host.ts).
const dev = developmentHost;

if (
  DESKTOP_BUILD_PROFILE !== "dev" &&
  process.platform === "win32" &&
  app.commandLine.hasSwitch(COOKIE_KEY_WRITER_SWITCH)
) {
  runCookieKeyWriter();
} else {
  start();
}

/**
 * Step 2: a cookie key writer. It draws nothing, so no GPU; by `ready` Chromium has made the key,
 * and quitting cleanly writes it to Local State. Before quitting it prints the probe its launch checks
 * (src/main/cookie-key.ts), synchronously, as the only line on its stdout. An uncaught error ends it
 * at once with a non-zero status: Electron's error dialog would block it, and the launch waiting for it.
 */
function runCookieKeyWriter(): void {
  const crash = cookieKeyWriterCrashHandler((code) => process.exit(code));
  process.on("uncaughtException", crash);
  process.on("unhandledRejection", crash);
  app.disableHardwareAcceleration();
  void app.whenReady().then(finishCookieKeyWriter);
}

function finishCookieKeyWriter(): void {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      writeSync(1, cookieKeyProbeLine(safeStorage.encryptString(COOKIE_KEY_PROBE_TEXT)));
    }
  } catch {
    // No probe: the launch notes that it could not check.
  }
  app.quit();
}

/** Steps 3 to 6. */
function start(): void {
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

  // A development instance keeps its own storage, apart from the installed app's (the dev build's
  // DESKTOP_USER_DATA_SUFFIX); test launches name theirs with --user-data-dir (scripts/launch.ts),
  // which Electron has applied to the userData path already.
  const { userData, compileCacheDir } = configureUserData(app, dev?.userDataSuffix);

  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  // Not in dev: its unpackaged Electron has no EnableCookieEncryption fuse, so its cookies are stored
  // unencrypted and need no key, and it restarts too often to pay for a writer run. An unpackaged
  // test launch has no such fuse either and runs the writer all the same: one extra start on a fresh
  // profile, and the unpackaged tests then cover the same startup path as the packaged ones.
  const cookieKey: CookieKeyOutcome =
    DESKTOP_BUILD_PROFILE === "dev"
      ? { kind: "none" }
      : storeCookieKeyFirst({
          platform: process.platform,
          userData,
          execPath: process.execPath,
          appPath: process.defaultApp ? app.getAppPath() : undefined,
          appVersion: app.getVersion(),
        });
  if (cookieKey.kind === "ran") profile.note("cookie-key-writer-ms", cookieKey.ms);
  logCookieKey(log, cookieKey);

  // Before `ready`: the scheme behaves like https (standard origin, fetch and streams, CORS, code cache).
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        allowServiceWorkers: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);

  // Not awaited at the top level: Electron defers `ready` until this module has evaluated. One
  // `catch` for both `whenReady` and `main` itself: a failure anywhere in startup exits.
  app
    .whenReady()
    .then(() => main({ log, debug, profile, compileCacheDir, cookieKey }))
    .catch(async (err: unknown) => {
      log.error({ err }, "startup failed");
      await server?.shutdown().catch(() => {});
      app.exit(1);
    });
}

/**
 * What an unstored key costs: a packaged app (EnableCookieEncryption fuse) encrypts its cookies, an
 * unpackaged launch (`electron <dir>`, no fuses) stores them in the clear and loses nothing.
 */
function unstoredKeyRisk(): string {
  return app.isPackaged
    ? "a crash in this launch's first ~10 s loses its persistent cookies"
    : "this unpackaged launch does not encrypt its cookies, so they are not at risk";
}

function logCookieKey(log: Logger, cookieKey: CookieKeyOutcome): void {
  if (cookieKey.kind === "ran" && cookieKey.key === "stored") {
    log.info({ ms: cookieKey.ms }, COOKIE_KEY_STORED_MESSAGE);
  } else if (cookieKey.kind === "ran" && cookieKey.key === "missing") {
    // Recorded: later launches of this version skip the writer for a day while the key is missing.
    log.warn(
      { ms: cookieKey.ms, status: cookieKey.status, error: cookieKey.error, risk: unstoredKeyRisk() },
      COOKIE_KEY_NOT_STORED_MESSAGE,
    );
  } else if (cookieKey.kind === "ran") {
    // Local State could not be read after the writer: nothing recorded, the next launch checks again.
    log.warn(
      { ms: cookieKey.ms, status: cookieKey.status, error: cookieKey.error, reason: cookieKey.readError },
      COOKIE_KEY_UNKNOWN_MESSAGE,
    );
  } else if (cookieKey.kind === "unreadable") {
    log.warn({ reason: cookieKey.reason, risk: unstoredKeyRisk() }, COOKIE_KEY_UNREADABLE_MESSAGE);
  } else if (cookieKey.kind === "skipped") {
    log.warn({ failedAt: cookieKey.failedAt, risk: unstoredKeyRisk() }, COOKIE_KEY_SKIPPED_MESSAGE);
  }
}

/** Once ready: whether this launch runs on the key its writer stored (src/main/cookie-key.ts). */
function checkCookieKey(log: Logger, cookieKey: CookieKeyOutcome): void {
  if (cookieKey.kind !== "ran" || cookieKey.key !== "stored") return;
  if (cookieKey.probe === undefined) {
    log.warn({}, COOKIE_KEY_NO_PROBE_MESSAGE);
    return;
  }
  const checked = checkCookieKeyProbe(cookieKey.probe, (encrypted) => safeStorage.decryptString(encrypted));
  if (checked.ok) log.info({}, COOKIE_KEY_CHECKED_MESSAGE);
  else log.error({ reason: checked.reason, risk: unstoredKeyRisk() }, COOKIE_KEY_MISMATCH_MESSAGE);
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

async function main({ log, debug, profile, compileCacheDir, cookieKey }: Startup): Promise<void> {
  profile.mark("ready");
  const development = dev !== undefined;
  let mainWindowReady = false;
  const appSession = session.fromPartition("persist:app");
  installPermissionPolicy(appSession, log);
  // Preferences the page writes through the preload; every request carries the current ones.
  const visualMirror = createVisualMirror(app.getPath("userData"), { log });
  const applyNativeTheme = () => {
    const preference = visualMirror.colorScheme();
    nativeTheme.themeSource = preference === "auto" ? "system" : preference;
  };
  applyNativeTheme();
  app.on("before-quit", visualMirror.retryPending);
  app.once("will-quit", visualMirror.onColorSchemeChange(applyNativeTheme));
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
      themePreference: visualMirror.colorScheme(),
      darkColors: nativeTheme.shouldUseDarkColors,
    });
  const chromePolicy = currentChromePolicy();
  const bootstrap: DesktopBootstrap = { protocolVersion: 1, shell, mode: chromePolicy.resolvedMode };
  if (chromePolicy.fallbackReason) log.info({ reason: chromePolicy.fallbackReason }, "using system window decoration");
  const preloadPath = join(__dirname, "preload.cjs");
  const registry = createWindowRegistry({
    session: appSession,
    chrome: { bootstrap, currentPolicy: currentChromePolicy, visualMirror },
    preloadPath,
    appVersion: app.getVersion(),
    log,
    profile,
    logRendererConsole: DESKTOP_BUILD_PROFILE !== "release" && (development || debug.smoke),
    childAppearance: demoChildAppearance,
    keyForUrl: (url) => (/^\/settings\/*$/i.test(url.pathname) ? "settings" : undefined),
    askRecovery,
    // What an external verifier waits for: logged once, at info, in every build profile.
    onReady(_window, fixedKey) {
      if (fixedKey !== "primary" || mainWindowReady) return;
      mainWindowReady = true;
      log.info({}, MAIN_WINDOW_READY_MESSAGE);
    },
  });
  installVisualIpc(
    ipcMain,
    visualMirror,
    (event) => isTrustedSender(event, registry.byContentsId(event.sender.id)),
    log,
  );
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
  const cookies = createCookieJar({
    secureScheme: true,
    store: appSession.cookies,
    scheme: APP_SCHEME,
    host: APP_HOST,
    origin: APP_ORIGIN,
    storageOrigin: COOKIE_JAR_ORIGIN,
    upstreamHost: new URL(internalOrigin).hostname,
    fromPartition: (partition) => session.fromPartition(partition),
    installPermissionPolicy: (probe) => installPermissionPolicy(probe, log),
    log,
  });
  const cookieIpc: CookieIpcOptions = {
    jar: cookies,
    prefix: "desktop",
    ipcMain,
    changes: appSession.cookies,
    ownsSender: (sender) => registry.byContentsId(sender.id)?.webContents === sender && sender.session === appSession,
    isAppUrl,
    log,
  };
  installCookieIpc(cookieIpc);
  const cookieWorkers = installCookieWorkerIpc({
    ...cookieIpc,
    serviceWorkers: appSession.serviceWorkers,
    storage: cookieWakeStorage(app.getPath("userData"), log),
  });
  appSession.registerPreloadScript({ type: "service-worker", filePath: preloadPath });
  registerAppProtocol(appSession, {
    upstream,
    internalOrigin,
    desktop,
    cookies,
    log,
    profile,
  });
  if (dev) {
    log.info({ devServerUrl: dev.serverUrl }, `development: forwarding ${APP_SCHEME}:// to react-router dev`);
    dev.onReloadRequest(() => {
      for (const win of registry.windows()) win.webContents.reload();
    });
  }

  let quitting = false;
  // A window can veto quit while closing. Keep its recovery and shared server alive until all windows agree.
  app.on("will-quit", function finishQuit(event) {
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void Promise.allSettled([
      cookieWorkers.quitAll(),
      server?.shutdown(),
      flushForQuit(appSession.cookies, log),
    ]).finally(() => {
      app.off("will-quit", finishQuit);
      app.quit();
    });
  });

  const openMainWindow = () => registry.open(APP_ORIGIN + "/", "primary");
  const first = await openFirstWindow(appSession.cookies, log, profile, () => {
    if (quitting) return undefined;
    profile.mark("navigation-start");
    return openMainWindow();
  });
  if (!first) return;
  const initialLoad = first.loaded ?? Promise.resolve();
  // After the first window is on its way, so the check never delays it.
  checkCookieKey(log, cookieKey);

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
