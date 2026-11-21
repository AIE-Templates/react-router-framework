// Development, the way `electron-forge start` works, without Forge: `react-router dev` for the web
// app (desktop shell, own port), the three Vite builds of the dev profile in watch mode with the dev
// server address baked in, then Electron on their directory the way scripts/launch.ts starts the dev
// profile (`electron .vite/dev`, with a generated package.json carrying apps/desktop's name, product
// name and version, so the app name, version and userData directory are those of `electron .`). The
// main process must report the dev build profile. Main or utility rebuilt → Electron restarts;
// preload rebuilt → the window reloads. This is the only build of the dev profile. Runs on Node
// directly (type stripping).
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { release } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { stripVTControlCharacters } from "node:util";

import { CLIENT_DIGEST_FILE } from "../../../build-tools/web-client-integrity.ts";
import { BUILD_PROFILE_ENV, bundleDir } from "./build-profile.ts";
import { monitorDesktopChild } from "./child-run.ts";
import { launchSpec, writeDevPackageJson } from "./launch.ts";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const DEV_PORT = Number(process.env.DESKTOP_DEV_PORT?.trim() || 5174);
const devServerUrl = `http://127.0.0.1:${DEV_PORT}`;
const buildDir = join(desktopDir, bundleDir("dev"));

const workers = new Map<ChildProcess, Promise<void>>();
let shuttingDown = false;

const log = (msg: string) => process.stdout.write(`[dev] ${msg}\n`);

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: boolean; showsWindows?: boolean },
) {
  if (shuttingDown) throw new Error("Development session is closing");
  const manager = command === "pnpm" ? process.env.npm_execpath : undefined;
  const nodeScript = manager && /\.(?:cjs|mjs|js)$/i.test(manager);
  const child = spawn(nodeScript ? process.execPath : (manager ?? command), nodeScript ? [manager, ...args] : args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: [options.stdin ? "pipe" : "ignore", "pipe", "inherit"],
    // Its own process group, so the whole tree (pnpm → react-router → vite) dies with it.
    detached: process.platform !== "win32",
    // Windows: no console window flashing up for the console programs (pnpm, react-router, vite).
    // Never for Electron (`showsWindows`): the option starts a process with SW_HIDE, which Windows applies
    // to the first window it shows, so the app's main window stayed hidden or blank and never logged
    // MAIN_WINDOW_READY_MESSAGE.
    windowsHide: !options.showsWindows,
  });
  if (!options.showsWindows) {
    const closed = new Promise<void>((done) =>
      child.once("close", () => {
        workers.delete(child);
        done();
      }),
    );
    workers.set(child, closed);
  }
  return child;
}

function stopWorker(child: ChildProcess, force: boolean): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      if (child.exitCode === null && child.signalCode === null)
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", timeout: 3000 });
    } else process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

async function stopWorkers(): Promise<void> {
  const closed = Promise.all(workers.values());
  for (const child of workers.keys()) stopWorker(child, false);
  const force = setTimeout(() => {
    for (const child of workers.keys()) stopWorker(child, true);
  }, 3000);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Development workers did not close")), 6000);
      }),
    ]);
  } finally {
    clearTimeout(force);
    clearTimeout(deadline);
  }
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const results = await Promise.allSettled([electron.stop(), stopWorkers()]);
  for (const result of results) {
    if (result.status === "rejected") {
      log(String(result.reason));
      code = 1;
    }
  }
  process.exit(code);
}

/** Resolves once `child` prints a line containing `marker`; output is passed through meanwhile. */
function waitForOutput(child: ChildProcess, marker: string, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let done = false;
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line: string) => {
      process.stdout.write(`[${label}] ${line}\n`);
      if (!done && stripVTControlCharacters(line).includes(marker)) {
        done = true;
        resolvePromise();
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!done) reject(new Error(`${label} exited with ${code} before it was ready`));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms`);
}

function startElectron() {
  const spec = launchSpec("unpackaged", "dev");
  const spawnedAt = Date.now();
  const child = run(spec.command, spec.args, {
    showsWindows: true,
    cwd: spec.cwd,
    env: { ...spec.env, DESKTOP_USER_DATA_SUFFIX: process.env.DESKTOP_USER_DATA_SUFFIX ?? "dev" },
    stdin: true,
  });
  let stopping = false;
  const monitor = monitorDesktopChild(child, spec, spawnedAt, { isStopping: () => stopping });
  child.stdout?.pipe(process.stdout, { end: false });
  const finished = (async () => {
    try {
      return await monitor.finished;
    } catch (err) {
      // A rebuild or shutdown may stop the app before it prints its profile.
      // reap() must still confirm termination before the next instance starts.
      if (!stopping) throw err;
      return null;
    } finally {
      await monitor.reap();
    }
  })();

  return {
    child,
    finished,
    async stop() {
      stopping = true;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        // Let Electron flush cookies and quit before stopping its network service.
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(child.pid)], { windowsHide: true, timeout: 3000 }, (err) => {
            if (err) log(err.message);
          });
        } else child.kill("SIGTERM");
      }
      const timer = setTimeout(() => {
        log("development app did not quit within three seconds; stopping its process tree");
        monitor.kill();
      }, 3000);
      try {
        await finished;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Shutdown and overlapping rebuilds share the same stop, including helper cleanup. */
export function devElectron(start: typeof startElectron, closing: () => boolean, exited: (code: number) => void) {
  let active: ReturnType<typeof startElectron> | undefined;
  let stopping: Promise<void> | undefined;
  function stop() {
    if (!active) return stopping ?? Promise.resolve();
    const previous = active;
    active = undefined;
    stopping = previous.stop().finally(() => {
      stopping = undefined;
    });
    return stopping;
  }
  function launch() {
    if (closing()) return;
    const app = start();
    active = app;
    void app.finished.then(
      (code) => {
        if (active !== app) return;
        log(`electron exited with ${app.child.signalCode ?? code}`);
        return exited(code ?? 1);
      },
      (err: unknown) => {
        if (active === app) {
          log(String(err));
          exited(1);
        }
      },
    );
  }
  return {
    get current() {
      return active?.child;
    },
    restart() {
      if (closing() || stopping) return;
      if (!active) launch();
      else
        void stop()
          .then(launch)
          .catch((err: unknown) => {
            log(String(err));
            exited(1);
          });
    },
    stop,
  };
}

const electron = devElectron(
  startElectron,
  () => shuttingDown,
  (code) => void shutdown(code),
);

async function main(): Promise<void> {
  const shellEnv = {
    WEB_SHELL: "desktop",
    WEB_SHELL_PLATFORM: process.platform,
    // Electron reports the macOS product version, while os.release() reports the Darwin kernel.
    WEB_SHELL_OS_VERSION:
      process.platform === "darwin"
        ? execFileSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()
        : release(),
    ...(process.platform === "linux"
      ? {
          WEB_SHELL_DESKTOP_ENV: process.env.XDG_CURRENT_DESKTOP ?? "",
          WEB_SHELL_SESSION_TYPE: process.env.XDG_SESSION_TYPE ?? "",
        }
      : {}),
    DESKTOP_DEV: "1",
    DESKTOP_DEV_PORT: String(DEV_PORT),
  };
  log(`starting react-router dev on ${devServerUrl}`);
  const web = run(
    "pnpm",
    [
      "--filter",
      "web",
      "exec",
      "react-router",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(DEV_PORT),
      "--strictPort",
    ],
    {
      cwd: repoDir,
      env: shellEnv,
    },
  );
  // `react-router dev` relaunches itself once with --conditions=development; the server that
  // answers first goes away again. Wait for the relaunched one to announce itself, then for health.
  await waitForOutput(web, "Local:", "web");
  await waitForHttp(`${devServerUrl}/api/health`, 60_000);

  // Development never forks the utility (pages come from the dev server), and its bundle needs
  // the web production build, which a clean checkout does not have: build it only when it can be.
  const webServerBuild = join(repoDir, "apps/web/build/server/index.js");
  const clientRecord = join(repoDir, "apps/web/build", CLIENT_DIGEST_FILE);
  const entries =
    existsSync(webServerBuild) && existsSync(clientRecord) ? ["main", "preload", "utility"] : ["main", "preload"];
  if (entries.length === 2) log("no complete Web build yet: skipping the utility build (not used in development)");
  log(`building ${entries.join(", ")} in watch mode`);
  const buildEnv = { [BUILD_PROFILE_ENV]: "dev", DESKTOP_DEV_SERVER_URL: devServerUrl };
  await Promise.all(
    entries.map((entry) =>
      waitForOutput(
        run("pnpm", ["exec", "vite", "build", "--config", `vite.${entry}.config.ts`], {
          cwd: desktopDir,
          env: buildEnv,
        }),
        "built in",
        `vite:${entry}`,
      ),
    ),
  );

  writeDevPackageJson(desktopDir);
  log("starting electron");
  electron.restart();

  // Vite's watch mode can rewrite an output without changing it (e.g. right after the initial
  // build); only a changed content hash counts as a rebuild, otherwise Electron would restart for
  // nothing (and kill a smoke run).
  const hashes = new Map<string, string>();
  const hashOf = (file: string): string | undefined => {
    try {
      return createHash("sha256")
        .update(readFileSync(join(buildDir, file)))
        .digest("hex");
    } catch {
      return undefined;
    }
  };
  for (const file of ["main.cjs", "preload.cjs", "utility.mjs"]) {
    const hash = hashOf(file);
    if (hash) hashes.set(file, hash);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pendingFiles = new Set<string>();
  watch(buildDir, (_event, file) => {
    if (!file || !/\.(cjs|mjs)$/.test(file)) return;
    const hash = hashOf(file);
    if (!hash || hashes.get(file) === hash) return;
    hashes.set(file, hash);
    pendingFiles.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pendingFiles];
      pendingFiles.clear();
      if (files.some((f) => f === "main.cjs" || f === "utility.mjs")) {
        log(`${files.join(", ")} rebuilt, restarting electron`);
        electron.restart();
      } else if (files.includes("preload.cjs")) {
        log("preload rebuilt, reloading the window");
        electron.current?.stdin?.write("reload\n");
      }
    }, 300);
  });
}

if (import.meta.main) {
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGHUP", () => void shutdown(0));
  main().catch((err: unknown) => {
    log(err instanceof Error ? err.message : String(err));
    return shutdown(1);
  });
}
