import { join } from "node:path";

export interface DesktopMetadata {
  name: string;
  productName: string;
}

/** Keep names portable so electron-builder's filename sanitization is an identity operation. */
function portableFilename(value: string): string {
  if (
    !/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(value) ||
    /[ .]$/.test(value) ||
    /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)
  ) {
    throw new Error(`Use a portable desktop filename: ${JSON.stringify(value)}`);
  }
  return value;
}

/** Matches the builder's default names; executableName overrides are deliberately unsupported. */
export function packagedExecutable(
  out: string,
  metadata: DesktopMetadata,
  platform: NodeJS.Platform,
  arch: string,
): string {
  const product = portableFilename(metadata.productName);
  const name = portableFilename(metadata.name).toLowerCase();
  if (platform === "darwin") {
    return join(out, arch === "arm64" ? "mac-arm64" : "mac", `${product}.app`, "Contents", "MacOS", product);
  }
  if (platform === "win32") {
    return join(out, arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked", `${product}.exe`);
  }
  // electron-builder uses package.name (sanitizedName), not productName, for Linux by default.
  if (platform === "linux") return join(out, arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked", name);
  throw new Error(`Unsupported desktop packaging platform: ${platform}`);
}
