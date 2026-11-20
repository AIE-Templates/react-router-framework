import { realpathSync } from "node:fs";

import { _electron as electron, type ElectronApplication, type Page, test as base } from "@playwright/test";

import { killIfRunning } from "../scripts/child-run.ts";
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
  let pid: number | undefined;
  try {
    // On Windows Playwright may launch Electron through a separate launcher process.
    pid = await app.evaluate(() => process.pid);
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
    return { app, page, pid };
  } catch (err) {
    await app.close().catch(() => {});
    if (pid !== undefined) killIfRunning(pid);
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
export async function quit({ app, pid }: Launched): Promise<void> {
  await app.close();
  const until = Date.now() + 10_000;
  while (isAlive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  if (isAlive(pid)) throw new Error(`main process ${pid} still running after quit`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
    try {
      await provide(directory);
    } finally {
      removeUserDataDir(directory);
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
      if (isAlive(app.pid)) {
        try {
          await quit(app);
        } catch (err) {
          failures.push(err);
          try {
            killIfRunning(app.pid);
          } catch (killError) {
            failures.push(killError);
          }
        }
      }
    }
    if (failures.length) throw new AggregateError(failures, "Could not close all test apps cleanly");
  },
  desktop: async ({ launchApp }, provide) => {
    await provide(await launchApp());
  },
});

export { expect } from "@playwright/test";
