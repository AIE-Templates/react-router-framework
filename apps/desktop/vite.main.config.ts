import { defineConfig } from "vite";

import { entryConfig } from "./vite.base.config.ts";

// CommonJS: an ES module main entry would deadlock on a top-level `await app.whenReady()`, since
// Electron defers `ready` until the entry module has finished evaluating.
export default defineConfig(entryConfig({ entry: "src/main.ts", fileName: "main.cjs", format: "cjs" }));
