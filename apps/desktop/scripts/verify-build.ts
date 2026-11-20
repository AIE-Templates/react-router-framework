// `pnpm verify:build`: checks, on the bundler's own module lists (scripts/bundle-modules.ts), that
// each build profile bundles only what it may (PROFILE_ENTRIES in scripts/build-profile.ts).
//
//   node scripts/verify-build.ts [--no-build]
//
// - release: main.cjs, preload.cjs and utility.mjs contain nothing of src/diagnostics (other than the
//   empty entry), no development host or proxy and not the module that reads the debug environment
//   variables; the bundles that import those entries hold the empty implementations instead.
// - test, the positive control: the same detector must find the diagnostics and the debug
//   environment module in main.cjs and utility.mjs, or the release result would prove nothing. The
//   test bundles must not contain the development host either. The dev profile exists only while
//   scripts/dev.ts runs and is not checked here.
// By default it first builds the test and release desktop bundles (scripts/build.ts; the web build
// must exist), so what it checks is never out of date. `--no-build` checks the bundles on disk and
// fails when one is missing or its module record was not written for it.
// Runs on Node directly (type stripping), through pnpm.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { type BuildCommandProfile, BUNDLES } from "./build-profile.ts";
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
}
if (problems.length > 0) fail(problems.join("\nverify:build: "));
process.stdout.write(
  "verify:build: release bundles exclude the diagnostics, development and debug environment modules; " +
    "the test bundles confirm the check finds them\n",
);
