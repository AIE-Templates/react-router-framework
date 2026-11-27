// What the text of a desktop bundle must and must not contain per build profile: the second check
// of scripts/verify-build.ts, beside the module lists (scripts/bundle-modules.ts). A module list
// cannot see a debug variable read in some other file, or diagnostic code living outside
// src/diagnostics; the text of the bundle can, because none of these markers survives minification
// in any other form: they are environment variable names, URL path prefixes, the first word of an
// output line, a property of `globalThis` and a log message.
// - Environment variable names come from src/debug-env.names.ts, the list the modules that read them
//   use, so a variable cannot be read without being checked for.
// - Every marker a profile may contain must be found in at least one of its bundles: the positive
//   control, on the test bundles, that each of them is still what the source says.
// Runs on Node directly (type stripping).
import { DEBUG_ENV, DEV_ENV } from "../src/debug-env.names.ts";
import { REMOTE_DEBUGGING_REFUSED_MESSAGE, VISUAL_COOKIE_FAILED_MESSAGE } from "../src/startup-signals.ts";
import { type BuildProfile, type Bundle, bundleDir, BUNDLES } from "./build-profile.ts";

export interface BundleMarker {
  text: string;
  /** What the marker is, for messages. */
  kind: string;
  /** The profiles whose bundles contain it; in any other profile's bundles it is a failure. */
  profiles: readonly BuildProfile[];
  /** Match the whole name only: `DESKTOP_SMOKE` is not found in `DESKTOP_SMOKE_LAYOUT`. */
  name: boolean;
}

const DIAGNOSTIC_PROFILES = ["dev", "test"] as const;

export const BUNDLE_MARKERS: readonly BundleMarker[] = [
  ...Object.values(DEBUG_ENV).map((text) => ({
    text,
    kind: "debug environment variable",
    profiles: DIAGNOSTIC_PROFILES,
    name: true,
  })),
  ...Object.values(DEV_ENV).map((text) => ({
    text,
    kind: "development environment variable",
    profiles: ["dev"] as const,
    name: true,
  })),
  // SMOKE_PREFIX, BENCH_PREFIX and E2E_PREFIX of src/diagnostics/*/routes.ts.
  ...["/__smoke", "/__bench/", "/__e2e"].map((text) => ({
    text,
    kind: "diagnostic route prefix",
    profiles: DIAGNOSTIC_PROFILES,
    name: false,
  })),
  // The lines the smoke and the benchmark print their results on.
  ...["SMOKE_RESULT", "BENCH_RESULT"].map((text) => ({
    text,
    kind: "diagnostic result marker",
    profiles: DIAGNOSTIC_PROFILES,
    name: true,
  })),
  { text: "--e2e-hold-first-window", kind: "first-window test gate", profiles: DIAGNOSTIC_PROFILES, name: false },
  // What src/main.ts leaves on `globalThis` for the Playwright fixtures.
  { text: "desktopBuildProfile", kind: "build profile global", profiles: DIAGNOSTIC_PROFILES, name: true },
];

/** The `DESKTOP_*` environment variables a release build reads; LOG_LEVEL and XDG_* have other names. */
export const RELEASE_DESKTOP_ENV: readonly string[] = ["DESKTOP_CHROME_MODE"];

const NAME_CHARACTER = "[A-Za-z0-9_$]";

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whether `code` contains the marker. */
export function hasMarker(code: string, marker: Pick<BundleMarker, "text" | "name">): boolean {
  if (!marker.name) return code.includes(marker.text);
  return new RegExp(`(?<!${NAME_CHARACTER})${escaped(marker.text)}(?!${NAME_CHARACTER})`).test(code);
}

/**
 * Every `DESKTOP_*` name in `code` on its own (not the tail of a longer name such as
 * `WEB_SHELL_DESKTOP_ENV`), sorted, without duplicates.
 */
export function desktopNames(code: string): string[] {
  const names = code.matchAll(new RegExp(`(?<!${NAME_CHARACTER})DESKTOP_[A-Z0-9_]+`, "g"));
  return [...new Set(Array.from(names, (match) => match[0]))].toSorted();
}

export interface BundleTextCheck {
  /** What is wrong with the bundles' text, one sentence each; empty when it is as the profile requires. */
  problems: string[];
  /** What the check established. */
  findings: string[];
}

/**
 * Checks the text of one profile's three bundles.
 * - No bundle may contain a marker of another profile. For release that is every marker: no debug or
 *   development environment variable name, no diagnostic route prefix or result marker, no
 *   `desktopBuildProfile`. For test it is the dev build's environment variable.
 * - Release only: every `DESKTOP_*` name left in a bundle must be one a release build reads
 *   (RELEASE_DESKTOP_ENV), which also catches a debug variable nobody added to the list.
 * - Every marker of this profile must be in at least one bundle. On the test bundles this is the
 *   positive control: a marker the detector cannot find there proves nothing by being absent from
 *   the release bundles.
 * - main.cjs contains the remote debugging refusal (its log message) in release, and only there:
 *   the other profiles compile the refusal out, which is what makes its presence mean something.
 */
export function checkBundleTexts(
  profile: BuildProfile,
  code: Readonly<Record<Bundle, string>>,
  ssr?: boolean,
): BundleTextCheck {
  const problems: string[] = [];
  const findings: string[] = [];
  const where = (bundle: Bundle) => `${bundleDir(profile)}/${bundle}`;
  const foreign = BUNDLE_MARKERS.filter((marker) => !marker.profiles.includes(profile));
  const own = BUNDLE_MARKERS.filter((marker) => marker.profiles.includes(profile));

  for (const bundle of BUNDLES) {
    for (const marker of foreign) {
      if (hasMarker(code[bundle], marker)) {
        problems.push(
          `${where(bundle)} contains the ${marker.kind} ${marker.text}, which the ${profile} profile must not`,
        );
      }
    }
    if (profile === "release") {
      const unknown = desktopNames(code[bundle]).filter(
        (name) => !RELEASE_DESKTOP_ENV.includes(name) && !foreign.some((marker) => marker.text === name),
      );
      if (unknown.length > 0) {
        problems.push(
          `${where(bundle)} contains ${unknown.join(", ")}: a release build reads no DESKTOP_* variable but ` +
            RELEASE_DESKTOP_ENV.join(", "),
        );
      }
    }
  }
  if (foreign.length > 0 && problems.length === 0) {
    findings.push(
      `none of ${foreign.length} markers in ${BUNDLES.join(", ")} (${[...new Set(foreign.map((marker) => marker.kind))].join(", ")})`,
    );
  }

  const missing = own.filter((marker) => !BUNDLES.some((bundle) => hasMarker(code[bundle], marker)));
  for (const marker of missing) {
    problems.push(
      `no ${profile} bundle contains the ${marker.kind} ${marker.text}: the check cannot see what it looks for`,
    );
  }
  if (own.length > 0 && missing.length === 0) {
    findings.push(
      `all ${own.length} markers of the ${profile} profile found: ${own.map((marker) => marker.text).join(", ")}`,
    );
  }

  const refuses = code["main.cjs"].includes(REMOTE_DEBUGGING_REFUSED_MESSAGE);
  if (profile === "release" && !refuses) {
    problems.push(
      `${where("main.cjs")} does not contain "${REMOTE_DEBUGGING_REFUSED_MESSAGE}": it does not refuse remote debugging`,
    );
  } else if (profile !== "release" && refuses) {
    problems.push(
      `${where("main.cjs")} contains "${REMOTE_DEBUGGING_REFUSED_MESSAGE}": only release builds refuse remote ` +
        "debugging, so finding the message would no longer show that a build does",
    );
  } else {
    findings.push(
      profile === "release"
        ? `main.cjs refuses remote debugging ("${REMOTE_DEBUGGING_REFUSED_MESSAGE}")`
        : `main.cjs has no remote debugging refusal`,
    );
  }
  // Shipped bundles are linked to the verified build by SHA-256. Only a checkout has the Web mode record.
  if (ssr !== undefined) {
    const renderMode = ssr ? "SSR" : "SPA";
    if (code["main.cjs"].includes(VISUAL_COOKIE_FAILED_MESSAGE) !== ssr) {
      problems.push(`${where("main.cjs")} visual cookie pre-write disagrees with the ${renderMode} Web build`);
    } else {
      findings.push(`main.cjs visual cookie pre-write matches the ${renderMode} Web build`);
    }
  }
  return { problems, findings };
}
