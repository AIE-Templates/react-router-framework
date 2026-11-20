// `pnpm verify:build`: checks that each build profile bundles only what it may.
//
//   node scripts/verify-build.ts [--no-build]
//
// Two checks per profile, release first and test as its positive control:
// - Modules, on the bundler's own module lists (scripts/bundle-modules.ts; PROFILE_ENTRIES in
//   scripts/build-profile.ts). Release: main.cjs, preload.cjs and utility.mjs contain nothing of
//   src/diagnostics (other than the empty entry), no development host or proxy and not the module
//   that reads the debug environment variables; the bundles that import those entries hold the empty
//   implementations instead. Test: the same detector must find the diagnostics and the debug
//   environment module in main.cjs and utility.mjs, or the release result would prove nothing, and
//   must not find the development host.
// - Text, on the bundles themselves (scripts/bundle-markers.ts), for what a module list cannot see,
//   such as a debug variable read in some other file. Release: no debug or development environment
//   variable name, no diagnostic route prefix or result marker, no `desktopBuildProfile`, no
//   `DESKTOP_*` name but the ones a release build reads; main.cjs carries the remote debugging
//   refusal. Test: every one of those markers that belongs to it must be found, the development
//   variable must not, and main.cjs has no refusal.
// The dev profile exists only while scripts/dev.ts runs and is not checked here.
// By default it first builds the test and release desktop bundles (scripts/build.ts; the web build
// must exist), so what it checks is never out of date. `--no-build` checks the bundles on disk and
// fails when one is missing or its module record was not written for it.
// Runs on Node directly (type stripping), through pnpm.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { type BuildCommandProfile, type Bundle, bundleDir, BUNDLES } from "./build-profile.ts";
import { checkBundleTexts } from "./bundle-markers.ts";
import { checkBundleModules, readBundleModules } from "./bundle-modules.ts";
import { webServerEntry } from "./check-web-build.ts";

const desktopDir = resolve(import.meta.dirname, "..");
// Release first: it is what the check is for; test is its control.
const PROFILES: readonly BuildCommandProfile[] = ["release", "test"];

function fail(message: string): never {
  process.stderr.write(`verify:build: ${message}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--no-build") || args.length > 1) fail("Usage: verify-build.ts [--no-build]");

if (args.length === 0) {
  if (!existsSync(webServerEntry(desktopDir))) {
    fail("apps/web/build/server/index.js is missing: run `pnpm build:desktop` first");
  }
  for (const profile of PROFILES) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "build.ts"), profile], {
      cwd: desktopDir,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) fail(`building the ${profile} bundles failed`);
  }
}

const problems: string[] = [];
for (const profile of PROFILES) {
  for (const bundle of BUNDLES) {
    let modules: string[];
    try {
      ({ modules } = readBundleModules(desktopDir, profile, bundle));
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
    const check = checkBundleModules(profile, bundle, modules);
    problems.push(...check.problems);
    const label = `${profile} ${bundle} (${modules.length} modules)`;
    for (const finding of check.findings) process.stdout.write(`verify:build: ${label}: ${finding}\n`);
  }
  // The bundles exist and are the ones their records were written for.
  const read = (bundle: Bundle) => readFileSync(join(desktopDir, bundleDir(profile), bundle), "utf8");
  const text = checkBundleTexts(profile, {
    "main.cjs": read("main.cjs"),
    "preload.cjs": read("preload.cjs"),
    "utility.mjs": read("utility.mjs"),
  });
  problems.push(...text.problems);
  for (const finding of text.findings) process.stdout.write(`verify:build: ${profile} text: ${finding}\n`);
}
if (problems.length > 0) fail(problems.join("\nverify:build: "));
process.stdout.write(
  "verify:build: release bundles exclude the diagnostics, development and debug environment code and names " +
    "and refuse remote debugging; the test bundles confirm the checks find what they look for\n",
);
