import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

import { buildMacosAddon } from "./scripts/build-macos-addon.ts";
import { entryConfig } from "./vite.base.config.ts";

function macWindowAppearance(): Plugin {
  return {
    name: "mac-window-appearance",
    buildStart() {
      const source = resolve(import.meta.dirname, "native/window-appearance.mm");
      this.addWatchFile(source);
      const temp = mkdtempSync(join(tmpdir(), "window-appearance-"));
      const fileName = "window-appearance.node";
      try {
        buildMacosAddon(source, join(temp, fileName));
        this.emitFile({ type: "asset", fileName, source: readFileSync(join(temp, fileName)) });
      } finally {
        rmSync(temp, { recursive: true, force: true });
      }
    },
  };
}

const config = entryConfig({ entry: "src/main.ts", fileName: "main.cjs", format: "cjs" });
if (process.platform === "darwin") config.plugins?.push(macWindowAppearance());
export default defineConfig(config);
