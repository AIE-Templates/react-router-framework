import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { _electron as electron, type ElectronApplication, type Page, test as base } from "@playwright/test";

import {
  appProcesses,
  buildProfileMismatch,
  checkLaunchInputs,
  desktopDir,
  electronBinary,
  type LaunchTarget,
  launchSpec,
  packagedBinary,
} from "../scripts/launch.ts";

/**
 * What the Playwright Electron driver launches, both the test build profile, started the way
 * scripts/launch.ts says and checked at every launch:
 * - `unpackaged`: `electron .` in apps/desktop (package.json `main`: `.vite/test/main.cjs`), on the
 *   output of `pnpm build:desktop`;
 * - `packaged`: the test profile from `pnpm --filter desktop package` in `out/test` (no fuses flipped).
 *   The release profile turns `EnableNodeCliInspectArguments` off, so the driver cannot attach to it.
 */
export type Target = LaunchTarget;

export { desktopDir, electronBinary, packagedBinary };

/** Includes macOS helpers under Contents/Frameworks beside the main executable. */
export function targetProcesses(target: Target): number[] {
  const { command, processDir } = launchSpec(target, "test");
  return appProcesses(command, processDir);
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** The main process's PID, to check it is gone after `quit()`. */
  pid: number;
}

/**
 * Launches the app with `DESKTOP_E2E=1` (the `/__e2e/*` endpoints) and a user data directory of its
 * own (`DESKTOP_USER_DATA_SUFFIX`), checks it reports the test build profile, and waits for the first
 * window to finish hydrating. Unpackaged, the test bundles must exist and match the web build.
 */
export async function launch(target: Target, userDataSuffix: string): Promise<Launched> {
  const spec = launchSpec(target, "test");
  checkLaunchInputs(spec);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Nothing from a developer's shell that changes what the app does.
    if (value === undefined || /^(DESKTOP_|WEB_SHELL|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, spec.env, { DESKTOP_E2E: "1", DESKTOP_USER_DATA_SUFFIX: userDataSuffix });
  const app = await electron.launch({
    executablePath: spec.command,
    // Exercise the real permission policy without accessing the user's camera or microphone.
    args: [...spec.args, "--use-fake-device-for-media-stream"],
    cwd: spec.cwd,
    env,
  });
  // On Windows Playwright may launch Electron through a separate launcher process.
  const pid = await app.evaluate(() => process.pid);
  const page = await app.firstWindow();
  // Playwright reads the app's stdout itself, so the startup line is out of reach: the main process
  // of every non-release build exposes its profile instead (src/main.ts).
  const reported = await app.evaluate(() => globalThis.desktopBuildProfile);
  if (reported !== spec.profile) {
    await app.close().catch(() => {});
    throw buildProfileMismatch(reported, spec.profile);
  }
  await waitForApp(page);
  return { app, page, pid };
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
  /** A unique `DESKTOP_USER_DATA_SUFFIX` for this test; the directory is deleted afterwards. */
  userDataSuffix: string;
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
  userDataSuffix: async ({}, provide) => {
    await provide(`e2e-${randomUUID().slice(0, 8)}`);
  },
  launchApp: async ({ target, userDataSuffix }, provide) => {
    const launched: Launched[] = [];
    let userData: string | undefined;
    await provide(async () => {
      const app = await launch(target, userDataSuffix);
      launched.push(app);
      userData ??= await app.app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
      return app;
    });
    for (const app of launched) {
      if (isAlive(app.pid)) await quit(app).catch(() => process.kill(app.pid, "SIGKILL"));
    }
    if (userData && userData.endsWith(`-${userDataSuffix}`) && existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true });
    }
  },
  desktop: async ({ launchApp }, provide) => {
    await provide(await launchApp());
  },
});

export { expect } from "@playwright/test";
