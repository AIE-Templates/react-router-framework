// Electron's fuses for the packaged build profiles: what each one flips (`FUSES`, the one table),
// the electron-builder `afterPack` hook that flips them (both leaf configurations,
// electron-builder.test.yml and electron-builder.release.yml), and the read-back that checks a final
// packaged binary against the table (`checkPackagedFuses`), which the launchers run before every
// packaged launch (scripts/launch.ts). Fuses are compile-time switches baked into the binary, so they
// are flipped before code signing. The unpackaged bundles run this checkout's Electron, whose fuses
// are never flipped.
//
//   node scripts/fuses.ts [test | release] [--app <executable>]   (default test)
//
// reads the fuses of the packaged app in out/<profile> (or of `executable`), prints them and exits 1
// when one differs from the table. Runs on Node directly (type stripping).
import { join } from "node:path";

import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from "@electron/fuses";
import type { AfterPackContext } from "electron-builder";

import { type BuildProfile, bundleDir } from "./build-profile.ts";
import { writeNsisFileList } from "./nsis-files.ts";

/** The build profiles that are packaged; the dev profile only ever runs unpackaged. */
export type PackagedProfile = Exclude<BuildProfile, "dev">;

/** The fuses this project sets, in fuse wire order; any others keep Electron's default. */
export const FUSE_NAMES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
] as const;
export type FuseName = (typeof FUSE_NAMES)[number];

const release: Record<FuseName, boolean> = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
};

/**
 * Each packaged profile's fuses. The test package is the release package's set except where the
 * tools that drive it need otherwise; each such entry says why. It keeps cookie encryption on, so
 * its launches never reach the system keychain only because scripts/launch.ts passes the
 * mock-keychain or basic password store switches.
 */
export const FUSES: Readonly<Record<PackagedProfile, Readonly<Record<FuseName, boolean>>>> = {
  release,
  test: {
    ...release,
    // Playwright's Electron driver (e2e/desktop.ts) attaches to the main process through the Node
    // inspector (`--inspect=0`), which this fuse otherwise disables.
    EnableNodeCliInspectArguments: true,
  },
};

/** What the fuse wire of a binary says about one fuse. */
export type FuseReading = boolean | "removed" | "missing" | "unknown";

/** Reads one fuse's state from a fuse wire as `getCurrentFuseWire` returns it. */
function reading(wire: Readonly<Record<number, unknown>>, name: FuseName): FuseReading {
  const state = wire[FuseV1Options[name]];
  if (state === undefined) return "missing";
  if (state === FuseState.ENABLE) return true;
  if (state === FuseState.DISABLE) return false;
  if (state === FuseState.REMOVED) return "removed";
  return "unknown";
}

/** The six fuses as a fuse wire records them. */
export function fuseReadings(wire: Readonly<Record<number, unknown>>): Record<FuseName, FuseReading> {
  return {
    RunAsNode: reading(wire, "RunAsNode"),
    EnableCookieEncryption: reading(wire, "EnableCookieEncryption"),
    EnableNodeOptionsEnvironmentVariable: reading(wire, "EnableNodeOptionsEnvironmentVariable"),
    EnableNodeCliInspectArguments: reading(wire, "EnableNodeCliInspectArguments"),
    EnableEmbeddedAsarIntegrityValidation: reading(wire, "EnableEmbeddedAsarIntegrityValidation"),
    OnlyLoadAppFromAsar: reading(wire, "OnlyLoadAppFromAsar"),
  };
}

/** One line per fuse whose reading is not what `profile`'s column says; empty when all match. */
export function fuseMismatches(readings: Readonly<Record<FuseName, FuseReading>>, profile: PackagedProfile): string[] {
  return FUSE_NAMES.filter((name) => readings[name] !== FUSES[profile][name]).map(
    (name) => `${name} is ${String(readings[name])}, expected ${String(FUSES[profile][name])}`,
  );
}

/** `name=value` for each fuse, for logs. */
export function describeFuses(readings: Readonly<Record<FuseName, FuseReading>>): string {
  return FUSE_NAMES.map((name) => `${name}=${String(readings[name])}`).join(" ");
}

/**
 * Reads the fuses of the packaged executable (on macOS the binary inside the .app bundle; the fuse
 * wire itself sits in its Electron Framework) and throws, naming each difference, unless all six are
 * what `profile`'s column of `FUSES` says. Returns the readings.
 */
export async function checkPackagedFuses(
  executable: string,
  profile: PackagedProfile,
): Promise<Record<FuseName, FuseReading>> {
  const readings = fuseReadings(await getCurrentFuseWire(executable));
  const mismatches = fuseMismatches(readings, profile);
  if (mismatches.length > 0) {
    throw new Error(
      `The fuses of ${executable} are not those of the ${profile} profile (scripts/fuses.ts): ${mismatches.join("; ")}. ` +
        "Its packaging did not flip them (did the afterPack hook run?): repackage it.",
    );
  }
  return readings;
}

/** The packaged profile a leaf configuration packs, from its entry (`extraMetadata.main`). */
export function packagedProfileOf(entry: unknown): PackagedProfile {
  for (const profile of ["test", "release"] as const) {
    if (entry === `${bundleDir(profile)}/main.cjs`) return profile;
  }
  throw new Error(`Cannot tell the build profile of a package whose entry is ${JSON.stringify(entry)}`);
}

/** electron-builder `afterPack`: flips the fuses of the profile this package was built from. */
export default async function afterPack(context: AfterPackContext): Promise<void> {
  const { appOutDir, electronPlatformName, packager } = context;
  const { Arch } = await import("electron-builder");
  const profile = packagedProfileOf(packager.config.extraMetadata?.main);
  const name = packager.appInfo.productFilename;
  const binary =
    electronPlatformName === "darwin"
      ? join(appOutDir, `${name}.app`, "Contents", "MacOS", name)
      : electronPlatformName === "win32"
        ? join(appOutDir, `${name}.exe`)
        : join(appOutDir, linuxExecutableName(packager) ?? name);

  const fuses = FUSES[profile];
  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Flipping fuses invalidates the ad-hoc signature macOS arm64 binaries carry; redo it so the
    // app still launches before real signing happens.
    resetAdHocDarwinSignature: electronPlatformName === "darwin" && context.arch === Arch.arm64,
    [FuseV1Options.RunAsNode]: fuses.RunAsNode,
    [FuseV1Options.EnableCookieEncryption]: fuses.EnableCookieEncryption,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: fuses.EnableNodeOptionsEnvironmentVariable,
    [FuseV1Options.EnableNodeCliInspectArguments]: fuses.EnableNodeCliInspectArguments,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: fuses.EnableEmbeddedAsarIntegrityValidation,
    [FuseV1Options.OnlyLoadAppFromAsar]: fuses.OnlyLoadAppFromAsar,
  });
  if (electronPlatformName === "win32" && profile === "release") {
    writeNsisFileList(appOutDir, packager.projectDir, Arch[context.arch]);
  }
}

/** The Linux packager knows its executable name (lowercased package name unless configured). */
function linuxExecutableName(packager: AfterPackContext["packager"]): string | undefined {
  return "executableName" in packager && typeof packager.executableName === "string"
    ? packager.executableName
    : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let profile: PackagedProfile = "test";
  let executable: string | undefined;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "test" || arg === "release") profile = arg;
    else if (arg === "--app" && args.length > 0) executable = args.shift();
    else throw new Error("Usage: fuses.ts [test | release] [--app <executable>]");
  }
  // Imported here: scripts/launch.ts imports this module for `checkPackagedFuses`.
  const { packagedBinary } = await import("./launch.ts");
  const binary = executable ?? packagedBinary(undefined, profile);
  const readings = await checkPackagedFuses(binary, profile);
  process.stdout.write(`fuses: ${binary} matches the ${profile} profile: ${describeFuses(readings)}\n`);
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(`fuses: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
