import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, type ElectronApplication, type Page, test as base } from "@playwright/test";

/**
 * What the Playwright Electron driver launches:
 * - `unpackaged`: `electron .` in apps/desktop, on the output of `pnpm build:desktop`;
 * - `packaged`: the test profile from `pnpm --filter desktop package` (no fuses flipped). The release
 *   profile turns `EnableNodeCliInspectArguments` off, so the driver cannot attach to it at all.
 */
export type Target = "unpackaged" | "packaged";

export const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("electron/package.json"));
  return join(packageDir, "dist", readFileSync(join(packageDir, "path.txt"), "utf8").trim());
}

/** The test-profile executable electron-builder's `--dir` writes for this machine. */
export function packagedBinary(): string {
  const out = join(desktopDir, "out");
  if (process.platform === "darwin") {
    const dir = process.arch === "arm64" ? "mac-arm64" : "mac";
    return join(out, dir, "Desktop.app", "Contents", "MacOS", "Desktop");
  }
  if (process.platform === "win32")
    return join(out, process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked", "Desktop.exe");
  return join(out, process.arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked", "desktop");
}

/** Every process of a launch (main, renderer, GPU, utility) has its executable under this directory. */
export function processRoot(target: Target): string {
  if (target === "unpackaged") return dirname(electronBinary());
  const binary = packagedBinary();
  return process.platform === "darwin" ? resolve(binary, "../../..") : dirname(binary);
}

/** PIDs of processes whose command line contains `needle` (pgrep -f); empty on Windows. */
export function pgrep(needle: string): number[] {
  if (process.platform === "win32") return [];
  try {
    return execFileSync("pgrep", ["-f", needle], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number)
      .filter((pid) => pid !== process.pid);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** The main process's PID, to check it is gone after `quit()`. */
  pid: number;
}

/**
 * Launches the app with `DESKTOP_E2E=1` (the `/__e2e/*` endpoints) and a user data directory of its
 * own (`DESKTOP_USER_DATA_SUFFIX`), and waits for the first window to finish hydrating.
 */
export async function launch(target: Target, userDataSuffix: string): Promise<Launched> {
  const required =
    target === "unpackaged"
      ? [join(desktopDir, ".vite/build/main.cjs"), join(desktopDir, "../web/build/server/index.js")]
      : [packagedBinary()];
  for (const file of required) {
    if (!existsSync(file)) {
      const command = target === "unpackaged" ? "pnpm build:desktop" : "pnpm package:desktop";
      throw new Error(`${file} is missing: run \`${command}\` first`);
    }
  }
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // Nothing from a developer's shell that changes what the app does.
    if (value === undefined || /^(DESKTOP_|WEB_SHELL|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$)/.test(name)) continue;
    env[name] = value;
  }
  Object.assign(env, { DESKTOP_E2E: "1", DESKTOP_USER_DATA_SUFFIX: userDataSuffix, NODE_ENV: "production" });
  const app = await electron.launch(
    target === "unpackaged"
      ? { executablePath: electronBinary(), args: ["."], cwd: desktopDir, env }
      : { executablePath: packagedBinary(), args: [], env },
  );
  const pid = app.process().pid!;
  const page = await app.firstWindow();
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
