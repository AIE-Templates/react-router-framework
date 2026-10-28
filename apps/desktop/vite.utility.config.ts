import { defineConfig } from "vite";

import { entryConfig } from "./vite.base.config.ts";

// ES module: the bundled server (@repo/server's logger) has a top-level `await`, which a CommonJS
// bundle cannot hold. The web server build, React, React Router, Hono and pino are all bundled in.
export default defineConfig(entryConfig({ entry: "src/utility.ts", fileName: "utility.mjs", format: "es" }));
