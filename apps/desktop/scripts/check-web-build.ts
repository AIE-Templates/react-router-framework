// Checks that the two halves of the web app a desktop build ships come from the same web build: the
// server build, bundled into `.vite/<profile>/utility.mjs` when the desktop was built, and the client
// build in apps/web/build/client, which the utility serves unpackaged and packaging copies into the
// app's resources. Rebuilding the web app without rebuilding the desktop (or the other way round)
// leaves pages referencing hashed scripts and styles the client directory no longer has, or a
// utility running older server code than the web build on disk; this catches both before packaging
// and before every unpackaged launch, instead of as broken pages.
//
//   node scripts/check-web-build.ts [dev | test | release]   (default test)
//
// - The completed Web build records its client tree digest outside the client directory. The utility
//   embeds that digest, so desktop-only rebuilds cannot silently bless a changed client build.
// - Client half: every hashed `/assets/<name>-<hash>.<ext>` path the utility bundle references (the
//   route manifest, entry and route modules, stylesheets) must exist in
//   apps/web/build/client/assets. The reverse does not hold (assets that only other assets load are
//   not in the server build), so the digest covers even the files the server does not reference.
// - Server half: the utility build records the SHA-256 of the apps/web/build/server/index.js it
//   bundled in `.vite/<profile>/web-server.json` (`recordWebServerBuild`, vite.utility.config.ts);
//   that file must still have the same digest. The entry imports its chunks under content-hashed
//   names, so a change anywhere in the server build changes it.
// Runs on Node directly (type stripping); apps/web is only read.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import type { Plugin } from "vite";

import { CLIENT_DIGEST_FILE, clientDigest } from "../../../build-tools/web-client-integrity.ts";
import { type BuildProfile, buildProfileFrom, bundleDir } from "./build-profile.ts";

/** Where the utility build records the server build it bundled, beside utility.mjs. */
export const WEB_SERVER_RECORD = "web-server.json";

/** The web server build's entry, which the utility imports as `web/build/server/index.js`. */
export function webServerEntry(desktopDir: string): string {
  return resolve(desktopDir, "../web/build/server/index.js");
}

/** The digest recorded and compared: SHA-256 of the entry's source text. */
export function webServerDigest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function canonical(path: string): string {
  const file = resolve(path.split("?")[0]);
  return existsSync(file) ? realpathSync(file) : file;
}

/**
 * Vite plugin for the utility build: records the digest of the web server entry as it was bundled
 * in `web-server.json`, and fails the build when the bundle does not contain that entry. Watch
 * rebuilds that leave the entry untouched keep the digest of its last transform.
 */
export function recordWebServerBuild(entry: string): Plugin {
  let digest: string | undefined;
  return {
    name: "desktop:record-web-server-build",
    enforce: "pre",
    transform(code, id) {
      if (canonical(id) === canonical(entry)) digest = webServerDigest(code);
      return null;
    },
    footer() {
      const record = resolve(entry, "../../", CLIENT_DIGEST_FILE);
      if (!existsSync(record)) this.error(`missing ${record}: rebuild the Web app before the utility`);
      const expected = readFileSync(record, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(expected)) this.error(`invalid Web client digest in ${record}`);
      return `/*! web-client-sha256: ${expected} */`;
    },
    generateBundle() {
      if (digest === undefined) this.error(`the utility bundle does not contain ${entry}`);
      const source = JSON.stringify({ entry: "apps/web/build/server/index.js", sha256: digest }, null, 2) + "\n";
      this.emitFile({ type: "asset", fileName: WEB_SERVER_RECORD, source });
    },
  };
}

/** A quoted root-relative asset path with Vite's `-<8 character hash>` file name suffix. */
const HASHED_ASSET = /["'`]\/assets\/([\w.~-]+-[\w-]{8}\.[A-Za-z0-9]+)(?=["'`?#])/g;

/** The hashed client asset file names `code` (a bundle's source) references, sorted, without duplicates. */
export function referencedClientAssets(code: string): string[] {
  return [...new Set(Array.from(code.matchAll(HASHED_ASSET), (match) => match[1]))].toSorted();
}

/** Check source client files or packaged resources against the digest embedded in this utility. */
export function checkClientDigest(utility: string, clientDirectory: string): void {
  const expected = /^\/\*! web-client-sha256: ([a-f0-9]{64}) \*\/$/m.exec(utility)?.[1];
  if (expected === undefined || clientDigest(clientDirectory) !== expected) {
    throw new Error(
      `${show(clientDirectory)} does not match the web client digest in the utility bundle; rebuild the Web and desktop apps`,
    );
  }
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
 * Throws, saying what to rebuild, unless the profile's utility bundle, its server record and the web
 * build exist, every hashed asset the bundle references is present in the client build, and the
 * server entry on disk is the one the bundle was built from.
 */
export function checkWebBuild(desktopDir: string, profile: BuildProfile): void {
  const utility = join(desktopDir, bundleDir(profile), "utility.mjs");
  const assets = resolve(desktopDir, "../web/build/client/assets");
  const rebuild = `run \`${buildCommand(profile)}\` first`;
  if (!existsSync(utility)) throw new Error(`${show(utility)} is missing: ${rebuild}`);
  if (!existsSync(assets)) throw new Error(`${show(assets)} is missing: ${rebuild}`);
  const code = readFileSync(utility, "utf8");
  const referenced = referencedClientAssets(code);
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
  checkClientDigest(code, resolve(assets, ".."));
  const record = join(desktopDir, bundleDir(profile), WEB_SERVER_RECORD);
  const server = webServerEntry(desktopDir);
  if (!existsSync(record)) throw new Error(`${show(record)} is missing: ${rebuild}`);
  if (!existsSync(server)) throw new Error(`${show(server)} is missing: ${rebuild}`);
  const recorded: unknown = JSON.parse(readFileSync(record, "utf8"));
  const bundled =
    typeof recorded === "object" && recorded !== null && "sha256" in recorded ? recorded.sha256 : undefined;
  if (bundled !== webServerDigest(readFileSync(server, "utf8"))) {
    throw new Error(
      `${show(utility)} embeds a different web server build than ${show(server)}. ` +
        `${rebuild[0].toUpperCase()}${rebuild.slice(1)}.`,
    );
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (args.length > 1) throw new Error("Usage: check-web-build.ts [dev | test | release]");
    const profile = buildProfileFrom(args[0]);
    checkWebBuild(resolve(import.meta.dirname, ".."), profile);
    process.stdout.write(
      `web build check: ${bundleDir(profile)}/utility.mjs matches apps/web/build (client and server)\n`,
    );
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
