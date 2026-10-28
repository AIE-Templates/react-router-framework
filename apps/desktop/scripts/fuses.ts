// electron-builder `afterPack` hook for the release profile: flips Electron's fuses on the packaged
// binary, the same set the Electron Forge template ships with. Fuses are compile-time switches
// baked into the binary, so they must be set before code signing. They are not applied to the test
// profile: Playwright's Electron driver needs the Node CLI inspect arguments that this disables.
import { join } from "node:path";

import { flipFuses, FuseV1Options, FuseVersion } from "@electron/fuses";
import { type AfterPackContext, Arch } from "electron-builder";

export default async function afterPack(context: AfterPackContext): Promise<void> {
  const { appOutDir, electronPlatformName, packager } = context;
  const name = packager.appInfo.productFilename;
  const binary =
    electronPlatformName === "darwin"
      ? join(appOutDir, `${name}.app`, "Contents", "MacOS", name)
      : electronPlatformName === "win32"
        ? join(appOutDir, `${name}.exe`)
        : join(appOutDir, linuxExecutableName(packager) ?? name);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    // Flipping fuses invalidates the ad-hoc signature macOS arm64 binaries carry; redo it so the
    // app still launches before real signing happens.
    resetAdHocDarwinSignature: electronPlatformName === "darwin" && context.arch === Arch.arm64,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
}

/** The Linux packager knows its executable name (lowercased product name unless configured). */
function linuxExecutableName(packager: AfterPackContext["packager"]): string | undefined {
  return "executableName" in packager && typeof packager.executableName === "string"
    ? packager.executableName
    : undefined;
}
