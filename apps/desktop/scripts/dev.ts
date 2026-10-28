// Development, the way `electron-forge start` works, without Forge: `react-router dev` for the web
// app (desktop shell, own port), the three Vite builds in watch mode with the dev server address
// baked in, then Electron on the result. Main or utility rebuilt → Electron restarts; preload
// rebuilt → the window reloads. Runs on Node directly (type stripping).
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, watch } from "node:fs";
import { createRequire } from "node:module";
import { release } from "node:os";
import { dirname, join, resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const DEV_PORT = Number(process.env.DESKTOP_DEV_PORT ?? 5174);
const devServerUrl = `http://localhost:${DEV_PORT}`;
const buildDir = join(desktopDir, ".vite/build");

const children = new Set<ChildProcess>();
let electron: ChildProcess | undefined;
let shuttingDown = false;

const log = (msg: string) => process.stdout.write(`[dev] ${msg}\n`);

function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; stdin?: boolean },
): ChildProcess {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: [options.stdin ? "pipe" : "ignore", "pipe", "inherit"],
    // Its own process group, so the whole tree (pnpm → react-router → vite) dies with it.
    detached: true,
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function kill(child: ChildProcess): void {
  if (child.exitCode !== null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) kill(child);
  setTimeout(() => process.exit(code), 500).unref();
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** Resolves once `child` prints a line containing `marker`; output is passed through meanwhile. */
function waitForOutput(child: ChildProcess, marker: string, label: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let done = false;
    child.stdout?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      process.stdout.write(text.replace(/^/gm, `[${label}] `));
      if (!done && text.includes(marker)) {
        done = true;
        resolvePromise();
      }
    });
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

/** The Electron binary, the way `require("electron")` finds it, without importing the module. */
function electronBinary(): string {
  const require = createRequire(import.meta.url);
  const packageDir = dirname(require.resolve("electron/package.json"));
  return join(packageDir, "dist", readFileSync(join(packageDir, "path.txt"), "utf8").trim());
}

function startElectron(): ChildProcess {
  const child = run(electronBinary(), ["."], {
    cwd: desktopDir,
    env: { DESKTOP_USER_DATA_SUFFIX: "dev", NODE_ENV: "development" },
    stdin: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.once("exit", (code) => {
    if (shuttingDown || electron !== child) return;
    log(`electron exited with ${code}`);
    shutdown(code ?? 0);
  });
  return child;
}

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
    ["--filter", "web", "exec", "react-router", "dev", "--port", String(DEV_PORT), "--strictPort"],
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
  const entries = existsSync(webServerBuild) ? ["main", "preload", "utility"] : ["main", "preload"];
  if (entries.length === 2) log("no apps/web/build yet: skipping the utility build (not used in development)");
  log(`building ${entries.join(", ")} in watch mode`);
  const buildEnv = { DESKTOP_WATCH: "1", DESKTOP_DEV_SERVER_URL: devServerUrl };
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

  log("starting electron");
  electron = startElectron();

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
        const old = electron;
        electron = undefined;
        if (old && old.exitCode === null) {
          // The new instance must start after the old one is gone: it would otherwise lose the
          // single-instance lock and quit at once.
          old.once("exit", () => {
            if (!shuttingDown) electron = startElectron();
          });
          kill(old);
          setTimeout(() => old.exitCode === null && old.kill("SIGKILL"), 3000).unref();
        } else {
          electron = startElectron();
        }
      } else if (files.includes("preload.cjs")) {
        log("preload rebuilt, reloading the window");
        electron?.stdin?.write("reload\n");
      }
    }, 300);
  });
}

main().catch((err: unknown) => {
  log(err instanceof Error ? err.message : String(err));
  shutdown(1);
});
