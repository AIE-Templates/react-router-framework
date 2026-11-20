import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

import { recordWebServerBuild, webServerEntry } from "./scripts/check-web-build.ts";
import { entryConfig } from "./vite.base.config.ts";

// ES module: the bundled server (@repo/server's logger) has a top-level `await`, which a CommonJS
// bundle cannot hold. The web server build, React, React Router, Hono and pino are all bundled in;
// which server build it was is recorded beside the bundle (scripts/check-web-build.ts).
export default defineConfig({
  ...entryConfig({ entry: "src/utility.ts", fileName: "utility.mjs", format: "es" }),
  plugins: [recordWebServerBuild(webServerEntry(fileURLToPath(new URL(".", import.meta.url))))],
});
