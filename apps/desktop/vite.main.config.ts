import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defineConfig, type Plugin } from "vite";

import { webBuildSsr } from "../../build-tools/web-render-mode.ts";
import { buildMacosAddon } from "./scripts/build-macos-addon.ts";
import { BUILD_PROFILE_ENV } from "./scripts/build-profile.ts";
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
export default defineConfig(async () => {
  // Dev serves the live Router config. Test/release bundle an existing Web build,
  // which may have been produced in a different shell or with a different .env.
  const ssr =
    process.env[BUILD_PROFILE_ENV] === "dev"
      ? (await import("../web/react-router.config.ts")).default.ssr
      : webBuildSsr(resolve(import.meta.dirname, "../web/build"));
  return { ...config, define: { ...config.define, DESKTOP_SSR: JSON.stringify(ssr) } };
});
