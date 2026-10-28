import { join } from "node:path";

import { config as loadDotenv } from "dotenv";
import { expand } from "dotenv-expand";

// Production server: the web app (pages, the API and static files) on its own. In development,
// `react-router dev` serves src/host/app.ts via src/host/vite-plugin.ts. Other servers mount
// createWebApp() themselves; see the README.

// Load .env, if any, before anything reads process.env. Variables already set in the environment win.
expand(loadDotenv({ path: join(import.meta.dirname, ".env"), quiet: true }));
process.env.NODE_ENV ??= "production";

// A variable keeps tsc from type-checking the built output.
const BUILD_PATH = "./build/server/index.js";
const { createWebApp, logger, startServer }: typeof import("./src/host/index.ts") = await import(BUILD_PATH);

// Listens on HOST and PORT, honours TRUST_PROXY and shuts down gracefully on SIGTERM/SIGINT.
await startServer(createWebApp({ clientDir: join(import.meta.dirname, "build/client") }), { logger });
