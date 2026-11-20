import type { ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";

import { _electron as electron, type ElectronApplication, type Page, test as base } from "@playwright/test";

import { listProcesses } from "../scripts/child-run.ts";
import {
  appProcesses,
  buildProfileMismatch,
  checkLaunchInputs,
  desktopDir,
  electronBinary,
  freshUserDataDir,
  launchLocation,
  type LaunchTarget,
  launchSpec,
  packagedBinary,
  removeUserDataDir,
} from "../scripts/launch.ts";
import { windowsProcess } from "../scripts/powershell.ts";

/**
 * What the Playwright Electron driver launches, both the test build profile, started the way
 * scripts/launch.ts says and checked at every launch:
 * - `unpackaged`: `electron .` in apps/desktop (package.json `main`: `.vite/test/main.cjs`), on the
 *   output of `pnpm build:desktop`;
 * - `packaged`: the test profile from `pnpm --filter desktop package` in `out/test`, whose fuses are
 *   the release profile's except `EnableNodeCliInspectArguments` (scripts/fuses.ts), which the driver
 *   attaches through; the `packaged-fuses` project reads them back before any packaged test runs.
 *   The release profile turns that fuse off too, so the driver cannot attach to it.
 */
export type Target = LaunchTarget;

export { desktopDir, electronBinary, packagedBinary };

// A failed termination must not race the fixture that removes the app's data directory.
const removableProfiles = new Set<string>();

/** Includes macOS helpers under Contents/Frameworks beside the main executable. */
export function targetProcesses(target: Target): number[] {
  const { command, processDir } = launchLocation(target, "test");
  return appProcesses(command, processDir);
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** The main process's PID, to check it is gone after `quit()`. */
  pid: number;
  close: () => Promise<void>;
}

/**
 * Launches the app with `DESKTOP_E2E=1` (the `/__e2e/*` endpoints) on `userDataDir`
 * (`--user-data-dir`), checks it reports the test build profile, runs on that directory and, on
 * Linux, keeps its secrets in the basic store rather than a keyring, and waits for the first window
 * to finish hydrating. Unpackaged, the test bundles must exist and match the web build; packaged, the
 * app must have the test profile's fuses. On Linux the Chromium sandbox stays on wherever it can start
 * (scripts/launch.ts); where it cannot, launchSpec has said so and Playwright adds `--no-sandbox`. A
 * launch that fails any of this is closed before the error reaches the caller.
 */
export async function launch(target: Target, userDataDir: string): Promise<Launched> {
  const spec = launchSpec(target, "test", { userDataDir });
  await checkLaunchInputs(spec);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Nothing from a developer's shell that changes what the app does.
    if (value === undefined || /^(DESKTOP_|WEB_SHELL|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, spec.env, { DESKTOP_E2E: "1" });
  const app = await electron.launch({
    executablePath: spec.command,
    // Exercise the real permission policy without accessing the user's camera or microphone.
    args: [...spec.args, "--use-fake-device-for-media-stream"],
    cwd: spec.cwd,
    env,
    // Playwright otherwise adds `--no-sandbox` on Linux by itself, silently.
    chromiumSandbox: !spec.args.includes("--no-sandbox"),
  });
  const launcher = app.process();
  let main: { pid: number; startedAt?: number } | undefined;
  const close = () =>
    closeApplication(app, launcher, main, () => {
      removableProfiles.delete(userDataDir);
      process.stderr.write(`e2e: exit unconfirmed; keeping user data in ${userDataDir}\n`);
    });
  try {
    // On Windows Playwright may launch Electron through a separate launcher process.
    main = await app.evaluate(() => {
      const created = process.platform === "win32" ? process.getCreationTime() : null;
      return { pid: process.pid, startedAt: created === null ? undefined : Math.trunc(created) };
    });
    if (main.pid !== launcher.pid && (process.platform !== "win32" || main.startedAt === undefined))
      throw new Error("Cannot verify the identity of the launched Electron main process");
    const page = await app.firstWindow();
    // Playwright reads the app's stdout itself, so the startup line is out of reach: the main process
    // of every non-release build exposes its profile instead (src/main.ts).
    const reported = await app.evaluate(() => globalThis.desktopBuildProfile);
    if (reported !== spec.profile) throw buildProfileMismatch(reported, spec.profile);
    // The app's data must be where the test put it, not in the installed app's directory.
    const userData = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
    if (realpathSync(userData) !== realpathSync(userDataDir)) {
      throw new Error(`The app runs on user data ${userData}, not on ${userDataDir}`);
    }
    // `--password-store=basic` must keep Linux launches off a running keyring (gnome-keyring,
    // KWallet), which could prompt or hang. macOS has no such reading: `--use-mock-keychain` swaps
    // the keychain under safeStorage without changing anything safeStorage reports.
    if (process.platform === "linux") {
      const backend = await app.evaluate(({ safeStorage }) => safeStorage.getSelectedStorageBackend());
      if (backend !== "basic_text") {
        throw new Error(`The app keeps its secrets in ${backend}, not in the basic store (--password-store=basic)`);
      }
    }
    await waitForApp(page);
    return { app, page, pid: main.pid, close };
  } catch (err) {
    await close().catch((closeError: unknown) => {
      process.stderr.write(`e2e: cleanup after failed launch: ${String(closeError)}\n`);
    });
    throw err;
  }
}

/** Waits until the page is the hydrated desktop document. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.dataset.hydrated === "true" && document.documentElement.dataset.shell === "desktop",
  );
}

/** Quits the app the way a user does (`app.quit()`, so `before-quit` runs) and waits for the process. */
export function quit({ close }: Launched): Promise<void> {
  return close();
}

/** Keep the original child handle even after Playwright disposes the app. On Windows it can be cmd.exe. */
export async function closeApplication(
  app: Pick<ElectronApplication, "close">,
  launcher: Pick<ChildProcess, "pid" | "exitCode" | "signalCode" | "kill">,
  main?: { pid: number; startedAt?: number },
  onExitUnconfirmed?: () => void,
): Promise<void> {
  const separateMain = process.platform === "win32" && main && main.pid !== launcher.pid ? main : undefined;
  const launcherRunning = () => launcher.exitCode === null && launcher.signalCode === null;
  const mainRunning = (timeout: number) => {
    if (!separateMain || separateMain.startedAt === undefined) return false;
    try {
      // Cheap probe after normal shutdown. Only the pinned process object can confirm identity or kill.
      process.kill(separateMain.pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
      throw error;
    }
    return windowsProcess(separateMain, "check", timeout);
  };
  let forcedGroup: number | undefined;
  const waitForExit = async (deadline: number) => {
    while (
      launcherRunning() ||
      mainRunning(Math.max(1, deadline - Date.now())) ||
      (forcedGroup !== undefined && listProcesses().some((item) => !item.zombie && item.pgid === forcedGroup))
    ) {
      if (Date.now() >= deadline) throw new Error("the owned process did not exit before the deadline");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const until = Date.now() + 10_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    if (!launcherRunning() && !mainRunning(10_000)) return;
    await Promise.race([
      app.close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the app did not close within 10 seconds")), 10_000);
      }),
    ]);
    await waitForExit(until);
  } catch (err) {
    const deadline = Date.now() + 5_000;
    try {
      try {
        if (separateMain) windowsProcess(separateMain, "kill", 5_000);
        // Playwright spawns Electron as a dedicated POSIX process-group leader.
        if (
          process.platform !== "win32" &&
          launcherRunning() &&
          launcher.pid &&
          listProcesses().some((item) => item.pid === launcher.pid && item.pgid === launcher.pid && !item.zombie)
        ) {
          forcedGroup = launcher.pid;
          process.kill(-launcher.pid, "SIGKILL");
        }
      } finally {
        if (launcherRunning()) launcher.kill("SIGKILL");
      }
    } catch (killError) {
      process.stderr.write(`e2e: could not stop the owned process: ${String(killError)}\n`);
    }
    try {
      await waitForExit(deadline);
    } catch (waitError) {
      process.stderr.write(`e2e: could not confirm process exit: ${String(waitError)}\n`);
      onExitUnconfirmed?.();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

interface Fixtures {
  /** A fresh user data directory for this test, shared by its launches; deleted afterwards. */
  userDataDir: string;
  /** Launch the app for this test; every app launched through it is quit after the test. */
  launchApp: () => Promise<Launched>;
  /** The first launch, for tests that need only one. */
  desktop: Launched;
}

interface Options {
  target: Target;
}

export const test = base.extend<Fixtures & Options>({
  target: ["unpackaged", { option: true }],
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixtures destructure their dependencies
  userDataDir: async ({}, provide) => {
    const directory = freshUserDataDir("e2e");
    removableProfiles.add(directory);
    try {
      await provide(directory);
    } finally {
      if (removableProfiles.delete(directory)) removeUserDataDir(directory);
    }
  },
  launchApp: async ({ target, userDataDir }, provide) => {
    const launched: Launched[] = [];
    await provide(async () => {
      const app = await launch(target, userDataDir);
      launched.push(app);
      return app;
    });
    const failures: unknown[] = [];
    for (const app of launched) {
      try {
        await quit(app);
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Could not close all test apps cleanly");
  },
  desktop: async ({ launchApp }, provide) => {
    await provide(await launchApp());
  },
});

export { expect } from "@playwright/test";
