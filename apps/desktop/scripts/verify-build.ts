// `pnpm verify:build`: verifies release bundle isolation (module lists + text markers) using test
// bundles as positive controls. Usage: node scripts/verify-build.ts [--no-build]
// Contract: docs/specs/electron-shell.spec.md (HOST-11). Runs on Node directly (type stripping).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { webBuildSsr } from "../../../build-tools/web-render-mode.ts";
import { type BuildCommandProfile, type Bundle, bundleDir, BUNDLES, perBundle } from "./build-profile.ts";
import { checkBundleTexts } from "./bundle-markers.ts";
import { checkBundleModules, readBundleModules } from "./bundle-modules.ts";
import { webServerEntry } from "./check-web-build.ts";

const desktopDir = resolve(import.meta.dirname, "..");
// Release first: it is what the check is for; test is its control.
const PROFILES: readonly BuildCommandProfile[] = ["release", "test"];

/**
 * Builds the release and test desktop bundles (scripts/build.ts; the web build must exist, and this
 * must run through pnpm, as build.ts requires). Throws, saying what failed.
 */
export function buildCheckedBundles(directory: string = desktopDir): void {
  if (!existsSync(webServerEntry(directory))) {
    throw new Error("apps/web/build/server/index.js is missing: run `pnpm build:desktop` first");
  }
  for (const profile of PROFILES) {
    const result = spawnSync(process.execPath, [resolve(import.meta.dirname, "build.ts"), profile], {
      cwd: directory,
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`building the ${profile} bundles failed`);
  }
}

export interface BuildCheck {
  /** What is wrong, one sentence each; empty when every bundle is as its profile requires. */
  problems: string[];
  /** What the checks established, one line each, labelled. */
  findings: string[];
  /** The SHA-256 of each release bundle the checks ran on, as its module record holds it. */
  release: Record<Bundle, string>;
}

/**
 * Both checks on the bundles on disk, release and its test control. Throws when a bundle or its
 * module record is missing or stale (the record was not written for the bundle on disk).
 */
export function checkBuiltBundles(directory: string = desktopDir): BuildCheck {
  const problems: string[] = [];
  const findings: string[] = [];
  const ssr = webBuildSsr(resolve(directory, "../web/build"));
  const release = new Map<Bundle, string>();
  for (const profile of PROFILES) {
    for (const bundle of BUNDLES) {
      const { modules, renderedModules, sha256 } = readBundleModules(directory, profile, bundle);
      if (profile === "release") release.set(bundle, sha256);
      const check = checkBundleModules(profile, bundle, modules, renderedModules);
      problems.push(...check.problems);
      const label = `${profile} ${bundle} (${modules.length} loaded; ${renderedModules.length} rendered)`;
      findings.push(...check.findings.map((finding) => `${label}: ${finding}`));
    }
    const read = (bundle: Bundle) => readFileSync(join(directory, bundleDir(profile), bundle), "utf8");
    const text = checkBundleTexts(
      profile,
      {
        "main.cjs": read("main.cjs"),
        "preload.cjs": read("preload.cjs"),
        "utility.mjs": read("utility.mjs"),
      },
      ssr,
    );
    problems.push(...text.problems);
    findings.push(...text.findings.map((finding) => `${profile} text: ${finding}`));
  }
  return { problems, findings, release: perBundle((bundle) => release.get(bundle) ?? "") };
}

function fail(message: string): never {
  process.stderr.write(`verify:build: ${message}\n`);
  process.exit(1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--no-build") || args.length > 1) fail("Usage: verify-build.ts [--no-build]");
  let check: BuildCheck;
  try {
    if (args.length === 0) buildCheckedBundles();
    check = checkBuiltBundles();
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  for (const finding of check.findings) process.stdout.write(`verify:build: ${finding}\n`);
  if (check.problems.length > 0) fail(check.problems.join("\nverify:build: "));
  process.stdout.write(
    "verify:build: release bundles exclude the diagnostics, development and debug environment code and names " +
      "and refuse remote debugging; the test bundles confirm the checks find what they look for\n",
  );
}
