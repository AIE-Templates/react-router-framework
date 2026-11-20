// Which source modules a desktop bundle was built from, as the bundler itself reports it, and what
// that list must and must not contain per build profile (scripts/build-profile.ts, PROFILE_ENTRIES).
// - `recordBundleModules()` is a Vite plugin (vite.base.config.ts) that writes
//   `.vite/<profile>/<bundle>.modules.json` beside every bundle: the profile, the SHA-256 of the
//   bundle as written, the complete module graph (including tree-shaken modules), and the modules that rendered code in this chunk. The
//   records stay out of the packaged app (electron-builder.*.yml).
// - `bundleModuleProblems()` is the check scripts/verify-build.ts runs on those records. It never
//   looks at bundle text: minified output says little about where code came from.
// Runs on Node directly (type stripping).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type { Plugin } from "vite";

import {
  type BuildProfile,
  type Bundle,
  bundleDir,
  isBuildProfile,
  PROFILE_ENTRIES,
  type ProfileEntry,
} from "./build-profile.ts";
import { buildCommand } from "./check-web-build.ts";

export interface BundleModules {
  profile: BuildProfile;
  bundle: string;
  /** SHA-256 of the bundle file this record was written for. */
  sha256: string;
  /** Module ids relative to apps/desktop, with forward slashes, sorted; virtual modules keep their id. */
  modules: string[];
  renderedModules: string[];
}

/** The record's file name, beside the bundle. */
export function modulesRecordName(bundle: string): string {
  return `${bundle}.modules.json`;
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** A module id as records hold it: a file's path from `desktopDir` without its query, anything else as is. */
export function moduleName(id: string, desktopDir: string): string {
  const file = id.split("?")[0];
  if (id.startsWith("\0") || !isAbsolute(file)) return id;
  return relative(desktopDir, file).split(sep).join("/");
}

/**
 * Vite plugin: after each bundle is written, records the modules it was built from beside it. A
 * watch rebuild rewrites the record with the bundle.
 */
export function recordBundleModules(profile: BuildProfile, desktopDir: string): Plugin {
  const root = realpathSync(desktopDir);
  let modules: string[] = [];
  return {
    name: "desktop:record-bundle-modules",
    generateBundle() {
      modules = Array.from(this.getModuleIds(), (id) => moduleName(id, root)).toSorted();
    },
    writeBundle(options, bundle) {
      const directory = options.dir ?? (options.file ? dirname(options.file) : undefined);
      if (directory === undefined) this.error("no output directory to record the bundle's modules in");
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk" || !chunk.isEntry) continue;
        const record: BundleModules = {
          profile,
          bundle: chunk.fileName,
          sha256: sha256(readFileSync(join(directory, chunk.fileName))),
          modules,
          renderedModules: Object.entries(chunk.modules)
            .filter(([, module]) => module.renderedLength > 0)
            .map(([id]) => moduleName(id, root))
            .toSorted(),
        };
        writeFileSync(join(directory, modulesRecordName(chunk.fileName)), JSON.stringify(record, null, 2) + "\n");
      }
    },
  };
}

/**
 * Reads the record of one bundle of one profile. Throws, saying which command to run, when the
 * bundle or its record is missing, or when the record was written for another profile or for other
 * bundle contents than the file on disk (a stale or foreign bundle).
 */
export function readBundleModules(desktopDir: string, profile: BuildProfile, bundle: Bundle): BundleModules {
  const path = `${bundleDir(profile)}/${bundle}`;
  const recordPath = `${bundleDir(profile)}/${modulesRecordName(bundle)}`;
  const rebuild = `run \`${buildCommand(profile)}\` first`;
  for (const file of [path, recordPath]) {
    if (!existsSync(join(desktopDir, file))) throw new Error(`${file} is missing: ${rebuild}`);
  }
  const record: unknown = JSON.parse(readFileSync(join(desktopDir, recordPath), "utf8"));
  if (
    typeof record !== "object" ||
    record === null ||
    !("profile" in record && isBuildProfile(record.profile)) ||
    !("bundle" in record && typeof record.bundle === "string") ||
    !("sha256" in record && typeof record.sha256 === "string") ||
    !("modules" in record && Array.isArray(record.modules) && record.modules.every((id) => typeof id === "string")) ||
    !(
      "renderedModules" in record &&
      Array.isArray(record.renderedModules) &&
      record.renderedModules.every((id) => typeof id === "string")
    )
  ) {
    throw new Error(`${recordPath} is not a bundle module record: ${rebuild}`);
  }
  const { profile: recordedProfile, bundle: recordedBundle, sha256: digest, modules, renderedModules } = record;
  if (recordedProfile !== profile || recordedBundle !== bundle) {
    throw new Error(`${recordPath} describes ${recordedBundle} of the ${recordedProfile} profile: ${rebuild}`);
  }
  if (digest !== sha256(readFileSync(join(desktopDir, path)))) {
    throw new Error(`${recordPath} is stale: it was not written for the ${path} on disk; ${rebuild}`);
  }
  return { profile, bundle, sha256: digest, modules, renderedModules };
}

/** The modules of `modules` that belong to an entry's real implementation: the module itself and what it owns. */
export function realModules(entry: ProfileEntry, modules: readonly string[]): string[] {
  return modules.filter(
    (id) =>
      id !== entry.empty &&
      (id === entry.module || entry.owns.some((owned) => (owned.endsWith("/") ? id.startsWith(owned) : id === owned))),
  );
}

export interface BundleModuleCheck {
  /** What is wrong with the module list, one sentence each; empty when it is as the profile requires. */
  problems: string[];
  /** What the check established, one line per profile entry. */
  findings: string[];
}

/**
 * Checks one bundle's module list against PROFILE_ENTRIES. For an entry the profile does not bundle
 * (release: the debug environment, the diagnostics, the development host; test: the development
 * host), no module of its real implementation may be in the list, in any bundle, and the bundles
 * that import the entry must hold its empty implementation instead. For an entry the profile does
 * bundle, the bundles that import it must hold the real module and everything it owns that is
 * expected there, and not the empty one: the positive control that this detector does see such
 * modules where they exist.
 */
export function checkBundleModules(
  profile: BuildProfile,
  bundle: Bundle,
  modules: readonly string[],
  renderedModules: readonly string[],
  entries: readonly ProfileEntry[] = PROFILE_ENTRIES,
): BundleModuleCheck {
  const problems: string[] = [];
  const findings: string[] = [];
  const where = `${bundleDir(profile)}/${bundle}`;
  for (const entry of entries) {
    const enabled = entry.profiles.includes(profile);
    const real = realModules(entry, enabled ? renderedModules : modules);
    const imports = entry.bundles.includes(bundle);
    const empty = modules.includes(entry.empty);
    if (!enabled) {
      if (real.length > 0) {
        problems.push(`${where} contains ${real.join(", ")}, which the ${profile} profile must not bundle`);
      }
      if (imports && !empty) problems.push(`${where} does not contain ${entry.empty}`);
      if (real.length === 0 && (empty || !imports)) {
        findings.push(`no ${[entry.module, ...entry.owns].join(", ")}${imports ? `; ${entry.empty} instead` : ""}`);
      }
      continue;
    }
    if (!imports) continue;
    const owned = real.filter((id) => id !== entry.module);
    if (!real.includes(entry.module)) {
      problems.push(`${where} does not contain ${entry.module}: the check cannot see what it looks for`);
    }
    if (entry.owns.length > 0 && owned.length === 0) {
      problems.push(`${where} contains nothing of ${entry.owns.join(", ")}: the check cannot see what it looks for`);
    }
    if (empty) problems.push(`${where} contains ${entry.empty}, which the ${profile} profile must not bundle`);
    if (real.includes(entry.module) && !empty && (entry.owns.length === 0 || owned.length > 0)) {
      findings.push(`found ${real.join(", ")}`);
    }
  }
  return { problems, findings };
}
