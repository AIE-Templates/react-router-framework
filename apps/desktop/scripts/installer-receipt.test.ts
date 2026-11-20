import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { checkInstaller, recordInstaller } from "./installer-receipt.ts";

it("rejects a stale same-version installer or a rebuilt payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "nsis-receipt-"));
  try {
    const installer = join(root, "Desktop Setup 0.1.0.exe");
    const executable = join(root, "Desktop.exe");
    const asar = join(root, "resources/app.asar");
    await mkdir(join(root, "resources"));
    for (const path of [installer, executable, asar]) await writeFile(path, "original");
    await expect(checkInstaller(installer, "arm64", executable)).rejects.toMatchObject({ code: "ENOENT" });
    await recordInstaller(installer, "arm64", executable);
    await checkInstaller(installer, "arm64", executable);
    for (const path of [installer, executable, asar]) {
      await writeFile(path, "rebuilt");
      await expect(checkInstaller(installer, "arm64", executable)).rejects.toThrow(/do not match/);
      await writeFile(path, "original");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
