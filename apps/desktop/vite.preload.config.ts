import { defineConfig } from "vite";

import { entryConfig } from "./vite.base.config.ts";

// A sandboxed preload script must be a single CommonJS file.
export default defineConfig(entryConfig({ entry: "src/preload.ts", fileName: "preload.cjs", format: "cjs" }));
