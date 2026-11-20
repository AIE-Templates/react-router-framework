import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it } from "vitest";

import { writeNsisFileList } from "./nsis-files.ts";

it("compiles only the packaged files into the uninstaller, escaping literals and guarding directories", () => {
  const project = mkdtempSync(join(tmpdir(), "desktop-installer-"));
  try {
    const payload = join(project, "win-unpacked");
    mkdirSync(join(payload, "resources"), { recursive: true });
    writeFileSync(join(payload, "Desktop.exe"), "");
    writeFileSync(join(payload, "resources", "cost $1.txt"), "");
    writeNsisFileList(payload, project, "arm64");
    const instructions = readFileSync(join(project, ".vite", "nsis", "arm64.nsh"), "utf8")
      .trim()
      .split("\n");
    expect(instructions).toEqual([
      '!insertmacro CheckDirectory "$INSTDIR\\resources"',
      '!insertmacro RemoveInstalledFile "$INSTDIR\\Desktop.exe"',
      '!insertmacro RemoveInstalledFile "$INSTDIR\\resources\\cost $$1.txt"',
      'RMDir "$INSTDIR\\resources"',
    ]);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
