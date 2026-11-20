// The NSIS completion event fires after signing. Bind the installer to the exact signed
// executable and app.asar used for each payload, including when --no-build is used later.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArtifactCreated } from "electron-builder";

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function receipt(installer: string, executable: string): Promise<string> {
  const files = [installer, executable, join(dirname(executable), "resources", "app.asar")];
  const hashes = await Promise.all(files.map(digest));
  return hashes.join("\n") + "\n";
}

export async function recordInstaller(installer: string, arch: string, executable: string): Promise<void> {
  await writeFile(installer + "." + arch + ".sha256", await receipt(installer, executable));
}

export async function checkInstaller(installer: string, arch: string, executable: string): Promise<void> {
  const recorded = await readFile(installer + "." + arch + ".sha256", "utf8");
  if (recorded !== (await receipt(installer, executable))) {
    throw new Error(
      "The NSIS installer, application executable and app.asar do not match the recorded distribution build",
    );
  }
}

export default async function artifactBuildCompleted({ file, target, arch, packager }: ArtifactCreated): Promise<void> {
  if (target?.name !== "nsis" || !file.endsWith(".exe")) return;
  // NsisTarget records the actual appOutDir passed to build() for each architecture.
  if (!("archs" in target) || !(target.archs instanceof Map)) throw new Error("Missing NSIS payload directories");
  const { Arch } = await import("electron-builder");
  const directories: Map<unknown, unknown> = target.archs;
  const selected = arch == null ? directories : new Map([[arch, directories.get(arch)]]);
  if (!selected.size) throw new Error("Empty NSIS payload list");
  for (const [payloadArch, directory] of selected) {
    if (typeof payloadArch !== "number" || !Arch[payloadArch] || typeof directory !== "string") {
      throw new Error("Invalid NSIS payload directory");
    }
    await recordInstaller(file, Arch[payloadArch], join(directory, packager.appInfo.productFilename + ".exe"));
  }
}
