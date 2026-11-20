// Checks that the two halves of the web app a desktop build ships come from the same web build: the
// server build, bundled into `.vite/<profile>/utility.mjs` when the desktop was built, and the client
// build in apps/web/build/client, which the utility serves unpackaged and packaging copies into the
// app's resources. Rebuilding the web app without rebuilding the desktop (or the other way round)
// leaves pages referencing hashed scripts and styles the client directory no longer has; this
// catches that before packaging and before every unpackaged launch, instead of as broken pages.
//
//   node scripts/check-web-build.ts [dev | test | release]   (default test)
//
// Every hashed `/assets/<name>-<hash>.<ext>` path the utility bundle references (the route
// manifest, entry and route modules, stylesheets) must exist in apps/web/build/client/assets. The
// reverse does not hold (assets that only other assets load are not in the server build), so extra
// client files are fine. Runs on Node directly (type stripping); apps/web is only read.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { type BuildProfile, buildProfileFrom, bundleDir } from "./build-profile.ts";

/** A quoted root-relative asset path with Vite's `-<8 character hash>` file name suffix. */
const HASHED_ASSET = /["'`]\/assets\/([\w.~-]+-[\w-]{8}\.[A-Za-z0-9]+)(?=["'`?#])/g;

/** The hashed client asset file names `code` (a bundle's source) references, sorted, without duplicates. */
export function referencedClientAssets(code: string): string[] {
  return [...new Set(Array.from(code.matchAll(HASHED_ASSET), (match) => match[1]))].toSorted();
}

/** A path as messages show it, relative to where the command runs. */
function show(path: string): string {
  return relative(process.cwd(), path) || ".";
}

/** The command that produces a profile's bundles together with a matching web build. */
export function buildCommand(profile: BuildProfile): string {
  return profile === "dev" ? "pnpm dev:desktop" : profile === "test" ? "pnpm build:desktop" : "pnpm release:desktop";
}

/**
 * Throws, saying what to rebuild, unless the profile's utility bundle and the web client build exist
 * and every hashed asset the bundle references is present in the client build.
 */
export function checkWebBuild(desktopDir: string, profile: BuildProfile): void {
  const utility = join(desktopDir, bundleDir(profile), "utility.mjs");
  const assets = resolve(desktopDir, "../web/build/client/assets");
  const rebuild = `run \`${buildCommand(profile)}\` first`;
  if (!existsSync(utility)) throw new Error(`${show(utility)} is missing: ${rebuild}`);
  if (!existsSync(assets)) throw new Error(`${show(assets)} is missing: ${rebuild}`);
  const referenced = referencedClientAssets(readFileSync(utility, "utf8"));
  if (referenced.length === 0) {
    throw new Error(`${show(utility)} references no hashed web client assets: ${rebuild}`);
  }
  const present = new Set(readdirSync(assets));
  const missing = referenced.filter((file) => !present.has(file));
  if (missing.length > 0) {
    throw new Error(
      `${show(utility)} and ${show(assets)} come from different web builds; missing from the client build: ` +
        `${missing.join(", ")}. ${rebuild[0].toUpperCase()}${rebuild.slice(1)}.`,
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1) throw new Error("Usage: check-web-build.ts [dev | test | release]");
    const profile = buildProfileFrom(args[0]);
    checkWebBuild(resolve(import.meta.dirname, ".."), profile);
    process.stdout.write(`web build check: ${bundleDir(profile)}/utility.mjs matches apps/web/build/client\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
