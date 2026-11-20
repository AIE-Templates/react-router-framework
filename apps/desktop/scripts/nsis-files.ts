// Generate literal file deletions for NSIS. An application install directory can also
// contain user files, so neither uninstall nor upgrade may recursively delete it.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeNsisFileList(appDirectory: string, projectDirectory: string, arch: string): void {
  const checks: string[] = [];
  const removals: string[] = [];
  function visit(directory: string, parent: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      // Double a literal dollar in NSIS strings; Windows names cannot contain quotes.
      const target = parent + "\\" + entry.name.replaceAll("$", () => "$$");
      if (entry.isDirectory()) {
        // A user may have replaced an installed subdirectory with a junction.
        checks.push(`!insertmacro CheckDirectory "${target}"`);
        visit(join(directory, entry.name), target);
        removals.push(`RMDir "${target}"`);
      } else {
        removals.push(`!insertmacro RemoveInstalledFile "${target}"`);
      }
    }
  }
  visit(appDirectory, "$INSTDIR");
  const out = join(projectDirectory, ".vite", "nsis");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, arch + ".nsh"), "\uFEFF" + [...checks, ...removals].join("\n") + "\n");
}
