import { writeSync } from "node:fs";
import { join } from "node:path";

import type { PortFetch } from "@repo/port-fetch";
import { DESKTOP_PREFS_IPC, shellFromEnv, type DesktopBootstrap, type DesktopRequest } from "@repo/shared";
import { app, type BrowserWindow, dialog, nativeTheme, protocol, safeStorage, session } from "electron";

import type { DebugEnv } from "~/debug-env.contract.ts";
// These three are replaced per build profile (vite.base.config.ts): import them by exactly these names.
import { readDebugEnv, utilityDebugEnv } from "~/debug-env.ts";
import { selectMainRun } from "~/diagnostics/entry.ts";
import { developmentHost } from "~/main/dev-host.ts";

import { APP_ORIGIN, APP_SCHEME, isAppUrl } from "./main/app-url.ts";
import { type BootProfile, createBootProfile } from "./main/boot-profile.ts";
import { resolveChromePolicy } from "./main/chrome-policy.ts";
import { COOKIE_JAR_ORIGIN, createCookieJar, flushForQuit } from "./main/cookie-jar.ts";
import {
  checkCookieKeyProbe,
  COOKIE_KEY_PROBE_TEXT,
  cookieKeyProbeLine,
  type CookieKeyOutcome,
  storeCookieKeyFirst,
} from "./main/cookie-key.ts";
import { createLogger, type Logger } from "./main/log.ts";
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
import {
  COOKIE_KEY_CHECKED_MESSAGE,
  COOKIE_KEY_MISMATCH_MESSAGE,
  COOKIE_KEY_STORED_MESSAGE,
  COOKIE_KEY_WRITER_SWITCH,
  MAIN_WINDOW_READY_MESSAGE,
} from "./startup-signals.ts";

// The order of a launch, up to `ready`:
// 1. Release builds: a launch with a Chromium remote debugging switch ends here, before this process
//    starts anything (src/main/remote-debugging.ts). Cookie key writers are launches like any other.
// 2. Windows, test and release builds: a cookie key writer (COOKIE_KEY_WRITER_SWITCH, started by step
//    5 of another launch) does nothing but let Chromium make the cookie key and quit at `ready`
//    (`runCookieKeyWriter`): no log, no userData change, no scheme, no lock, no window, no utility.
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
 * (src/main/cookie-key.ts), synchronously, as the only line on its stdout.
 */
function runCookieKeyWriter(): void {
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
  // unencrypted and need no key, and it restarts too often to pay for a writer run.
  const cookieKey: CookieKeyOutcome =
    DESKTOP_BUILD_PROFILE === "dev"
      ? { kind: "none" }
      : storeCookieKeyFirst({
          platform: process.platform,
          userData,
          execPath: process.execPath,
          appPath: process.defaultApp ? app.getAppPath() : undefined,
        });
  logCookieKey(log, cookieKey);

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

function logCookieKey(log: Logger, cookieKey: CookieKeyOutcome): void {
  if (cookieKey.kind === "ran" && cookieKey.stored) {
    log.info({ ms: cookieKey.ms }, COOKIE_KEY_STORED_MESSAGE);
  } else if (cookieKey.kind === "ran") {
    log.warn(
      { ms: cookieKey.ms, status: cookieKey.status, error: cookieKey.error },
      "the cookie key writer did not store the cookie key; starting anyway, and later launches skip it while " +
        "the key is missing: a crash in this launch's first ~10 s loses its persistent cookies",
    );
  } else if (cookieKey.kind === "skipped") {
    log.warn(
      { failedAt: cookieKey.failedAt },
      "the cookie key is still not stored and an earlier cookie key writer run failed, so it was not run again: " +
        "a crash in this launch's first ~10 s loses its persistent cookies",
    );
  }
}

/** Once ready: whether this launch runs on the key its writer stored (src/main/cookie-key.ts). */
function checkCookieKey(log: Logger, cookieKey: CookieKeyOutcome): void {
  if (cookieKey.kind !== "ran" || !cookieKey.stored) return;
  if (cookieKey.probe === undefined) {
    log.warn({}, "the cookie key writer printed no probe; this launch cannot check it uses the stored key");
    return;
  }
  const checked = checkCookieKeyProbe(cookieKey.probe, (encrypted) => safeStorage.decryptString(encrypted));
  if (checked.ok) log.info({}, COOKIE_KEY_CHECKED_MESSAGE);
  else log.error({ reason: checked.reason }, COOKIE_KEY_MISMATCH_MESSAGE);
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
  // After the first window is on its way, so the check never delays it.
  checkCookieKey(log, cookieKey);

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
