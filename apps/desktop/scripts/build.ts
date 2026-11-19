// All supported desktop build paths use production inputs, including the web build that the
// utility bundles. Development deliberately uses scripts/dev.ts and its own watch environment.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const desktopDir = resolve(import.meta.dirname, "..");
const repoDir = resolve(desktopDir, "../..");
const mode = process.argv.slice(2);
if (mode.length > 1 || (mode.length === 1 && mode[0] !== "--workspace" && mode[0] !== "--with-web")) {
  throw new Error("Usage: build.ts [--workspace | --with-web]");
}

// pnpm ships both as a Node script and as a standalone executable. Use the invoking package
// manager directly, without a shell or a platform-specific pnpm.cmd shim.
const packageManager = process.env.npm_execpath;
if (!packageManager) throw new Error("Run this build through pnpm (pnpm build or pnpm build:desktop).");
const isNodeScript = /\.(?:cjs|mjs|js)$/i.test(packageManager);
const executable = isNodeScript ? process.execPath : packageManager;
const prefix = isNodeScript ? [packageManager] : [];
const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
delete env.DESKTOP_WATCH;
delete env.DESKTOP_DEV_SERVER_URL;
delete env.DESKTOP_DEV;

function run(args: string[], cwd: string): void {
  const result = spawnSync(executable, [...prefix, ...args], { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (mode[0] === "--workspace") {
  run(["-r", "build"], repoDir);
} else {
  if (mode[0] === "--with-web") run(["--filter", "web...", "build"], repoDir);
  for (const entry of ["main", "preload", "utility"]) {
    run(["exec", "vite", "build", "--config", `vite.${entry}.config.ts`], desktopDir);
  }
}
