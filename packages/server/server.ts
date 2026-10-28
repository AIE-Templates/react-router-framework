import { join } from "node:path";

import { config as loadDotenv } from "dotenv";
import { expand } from "dotenv-expand";

// The server on its own, for browser apps served from elsewhere (set ALLOWED_ORIGINS) or hosts that
// call it over HTTP. apps/web runs the same app in-process with React Router instead.

// Load .env, if any, before anything reads process.env. Variables already set in the environment win.
expand(loadDotenv({ path: join(import.meta.dirname, ".env"), quiet: true }));
process.env.NODE_ENV ??= "production";

// Imported after the environment is set up, since the logger reads it when its module loads.
const { createServerApp, logger, parseAllowedOrigins, startServer } = await import("./src/index.ts");

await startServer(createServerApp({ allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGINS) }), { logger });
